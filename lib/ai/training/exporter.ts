// Joins RoutingDecisionLog × TicketAssignment × TicketOutcome × TicketRating into training
// rows. Output format is JSONL — one line per (decision, candidate) pair, with the label
// derived from the outcome.
//
// Run:  npx tsx lib/ai/training/exporter.ts > training_data.jsonl

import { prisma } from '@/lib/prisma';

interface TrainingRow {
  decision_id: string;
  ticket_id: string;
  candidate_provider_id: string;
  was_picked: boolean;
  was_exploration: boolean;
  // Features at decision time, restored from the log's stored breakdown:
  candidate_score: number;
  candidate_breakdown: any;
  // Label (only populated for the picked candidate — counterfactuals get NaN):
  label: number | null;       // 1 = good outcome, 0 = bad/none, null = unknown (not picked)
  resolution_minutes?: number;
  first_time_fix?: boolean;
  rating_verdict?: 'GOOD' | 'BAD';
}

export async function exportTrainingData(opts: { since?: Date; limit?: number } = {}): Promise<TrainingRow[]> {
  const decisions = await prisma.routingDecisionLog.findMany({
    where: opts.since ? { created_at: { gte: opts.since } } : undefined,
    orderBy: { created_at: 'asc' },
    take: opts.limit,
    include: {
      ticket: {
        include: {
          outcome: true,
          rating: true,
          assignments: { orderBy: { assigned_at: 'desc' }, take: 1 }
        }
      }
    }
  });

  const rows: TrainingRow[] = [];

  for (const d of decisions) {
    const candidates = (d.candidates as any[]) ?? [];
    const pickedId = d.picked_provider_id;
    const ticket = d.ticket;
    const outcome = ticket?.outcome;
    const rating = ticket?.rating;
    const wasGood =
      rating?.verdict === 'GOOD' &&
      outcome?.first_time_fix === true &&
      outcome?.resolution_time_minutes !== undefined &&
      ticket?.sla_deadline &&
      outcome.resolved_at <= ticket.sla_deadline;

    for (const c of candidates) {
      const isPicked = c.provider_id === pickedId;
      rows.push({
        decision_id: d.id,
        ticket_id: d.ticket_id,
        candidate_provider_id: c.provider_id,
        was_picked: isPicked,
        was_exploration: d.was_exploration,
        candidate_score: c.score,
        candidate_breakdown: c.breakdown,
        label: isPicked ? (wasGood ? 1 : 0) : null,
        resolution_minutes: isPicked ? outcome?.resolution_time_minutes : undefined,
        first_time_fix: isPicked ? outcome?.first_time_fix : undefined,
        rating_verdict: isPicked ? rating?.verdict : undefined
      });
    }
  }

  return rows;
}

// Allow direct invocation: `npx tsx lib/ai/training/exporter.ts`
if (require.main === module) {
  exportTrainingData()
    .then(rows => {
      for (const r of rows) {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
      process.exit(0);
    })
    .catch(err => {
      console.error('Export failed:', err);
      process.exit(1);
    });
}
