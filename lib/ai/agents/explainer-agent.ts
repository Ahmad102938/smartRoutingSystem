// Async LLM explainer. Runs OFF the request path — kicked off after routing-agent commits
// the assignment, processes pending TicketAssignment rows in the background.
//
// What it does:
//   1. Pulls a PENDING TicketAssignment with its ticket, candidate scores, and asset context.
//   2. Asks Gemini to explain why this candidate is a good fit, OR flag if the heuristic
//      seems wrong.
//   3. Writes the explanation back to the assignment row + flips ai_disagreement if Gemini
//      pushed back hard. Does NOT auto-reroute — humans decide.
//
// The escalation-agent batch pattern is the precedent — both run periodically over
// findMany'd rows, both transform DB state, neither blocks user-facing latency.

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const ExplanationSchema = z.object({
  appropriate: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(20).max(2000),
  concerns: z.array(z.string()).optional()
});

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    appropriate: { type: SchemaType.BOOLEAN, description: 'True if the heuristic\'s pick looks correct.' },
    confidence: { type: SchemaType.NUMBER, description: 'Confidence in your judgement, 0 to 1.' },
    rationale: { type: SchemaType.STRING, description: 'One-paragraph explanation an admin can read.' },
    concerns: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: 'Specific concerns if appropriate=false.'
    }
  },
  required: ['appropriate', 'confidence', 'rationale']
};

export class ExplainerAgent {
  private model: GoogleGenerativeAI | null = null;
  private genModel: any = null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.trim() !== '') {
      try {
        this.model = new GoogleGenerativeAI(apiKey);
        this.genModel = this.model.getGenerativeModel({
          model: 'gemini-1.5-flash',
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA as any
          }
        });
      } catch (error) {
        console.warn('Failed to initialize Gemini for explainer:', error);
      }
    }
  }

  /**
   * Process pending explanations in batches. Designed to be called from a cron/scheduled
   * job (e.g. every 30s) or right after orchestrator returns from processNewTicket via a
   * setImmediate fire-and-forget.
   *
   * Returns the number of assignments processed (success or failure both count).
   */
  async processPending(batchSize = 10): Promise<number> {
    if (!this.genModel) {
      console.warn('Explainer agent skipped: Gemini not configured.');
      return 0;
    }

    const pending = await prisma.ticketAssignment.findMany({
      where: { explanation_status: 'PENDING' },
      orderBy: { assigned_at: 'asc' },
      take: batchSize,
      include: {
        ticket: {
          include: {
            asset: true,
            routing_decisions: { orderBy: { created_at: 'desc' }, take: 1 }
          }
        },
        service_provider: { select: { company_name: true, skills: true } }
      }
    });

    let processed = 0;
    for (const a of pending) {
      try {
        await this.explainOne(a as any);
      } catch (err) {
        console.error(`Explainer failed for assignment ${a.id}:`, err);
        await prisma.ticketAssignment.update({
          where: { id: a.id },
          data: {
            explanation_status: 'FAILED',
            explained_at: new Date()
          }
        });
      }
      processed++;
    }
    return processed;
  }

  private async explainOne(assignment: {
    id: string;
    service_provider_id: string;
    ticket: any;
    service_provider: { company_name: string; skills: string[] };
  }): Promise<void> {
    const { ticket, service_provider } = assignment;
    const decisionLog = ticket.routing_decisions?.[0];
    const candidates = decisionLog?.candidates ?? [];

    const prompt = this.buildPrompt(
      ticket.description,
      ticket.ai_classification_category,
      ticket.ai_classification_subcategory,
      ticket.ai_priority,
      service_provider,
      candidates,
      ticket.asset
    );

    const result = await this.genModel.generateContent(prompt);
    const text = result.response.text();
    const parsed = ExplanationSchema.parse(JSON.parse(text));

    const aiDisagreement = !parsed.appropriate && parsed.confidence > 0.6;

    await prisma.ticketAssignment.update({
      where: { id: assignment.id },
      data: {
        explanation: parsed.rationale + (parsed.concerns?.length
          ? `\n\nConcerns: ${parsed.concerns.join('; ')}`
          : ''),
        explanation_status: 'COMPLETED',
        ai_disagreement: aiDisagreement,
        explained_at: new Date()
      }
    });
  }

  private buildPrompt(
    description: string,
    category: string,
    subcategory: string,
    priority: string,
    chosen: { company_name: string; skills: string[] },
    candidates: any[],
    asset: any | null
  ): string {
    const candidatesText = candidates
      .slice(0, 5)
      .map((c: any, i: number) =>
        `${i + 1}. provider_id=${c.provider_id} score=${(c.score * 100).toFixed(1)}% breakdown=${JSON.stringify(c.breakdown)}`
      )
      .join('\n');

    const assetText = asset
      ? `Asset: ${asset.make ?? 'unknown make'} ${asset.model ?? 'unknown model'} (qr=${asset.qr_code})`
      : 'No asset linked.';

    return `You are auditing a ticket-routing decision. Your job is to evaluate whether the heuristic picked an appropriate service provider, OR flag specific concerns.

Ticket:
- Description: "${description}"
- Classification: ${category} / ${subcategory}
- Priority: ${priority}
- ${assetText}

Picked provider: ${chosen.company_name}
Their skills: ${chosen.skills.join(', ') || '(none listed)'}

Top candidates (sorted by heuristic score):
${candidatesText || '(only one candidate)'}

Respond with strict JSON matching this schema:
{
  "appropriate": boolean,           // true = pick is reasonable; false = there's a problem
  "confidence": number (0..1),      // your confidence in this judgement
  "rationale": string,              // 2-4 sentence explanation a non-technical admin can read
  "concerns": string[] (optional)   // specific concerns if appropriate=false
}

Be honest — if the picked provider's skills clearly don't match the ticket category, say so. If there's a higher-scoring candidate that the policy should have picked but exploration overrode, mention it.`;
  }
}

export const explainerAgent = new ExplainerAgent();
