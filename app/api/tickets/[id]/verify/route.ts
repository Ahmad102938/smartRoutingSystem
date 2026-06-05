import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { requirePermission, getTicketContext } from '@/lib/auth/rbac';
import { prisma } from '@/lib/prisma';
import { similarityAgent } from '@/lib/ai/agents/similarity-agent';
import { z } from 'zod';

const VerifyTicketSchema = z.object({
  verdict: z.enum(['GOOD', 'BAD']),
  tags: z.array(z.string()).default([]),
  comment: z.string().max(2000).optional()
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const context = await getTicketContext(params.id, session.user);
    await requirePermission('ticket', 'verify', context);

    const body = await request.json();
    const data = VerifyTicketSchema.parse(body);

    const rating = await prisma.ticketRating.upsert({
      where: { ticket_id: params.id },
      update: {
        verdict: data.verdict,
        tags: data.tags,
        comment: data.comment ?? null,
        moderator_user_id: session.user.id,
        rated_at: new Date()
      },
      create: {
        ticket_id: params.id,
        moderator_user_id: session.user.id,
        verdict: data.verdict,
        tags: data.tags,
        comment: data.comment
      }
    });

    // GOOD verdict closes the ticket; BAD reopens it as in-progress so the
    // technician can re-attempt or it can be reassigned.
    if (data.verdict === 'GOOD') {
      await prisma.ticket.update({
        where: { id: params.id },
        data: { status: 'CLOSED', closed_at: new Date() }
      });

      // Refresh the resolving technician's skill_embedding from their last 20 verified-good
      // outcomes. Fire-and-forget — the verification response shouldn't wait on bge inference.
      const outcome = await prisma.ticketOutcome.findUnique({
        where: { ticket_id: params.id },
        select: { resolved_by_user_id: true }
      });
      if (outcome) {
        similarityAgent.refreshTechnicianSkillEmbedding(outcome.resolved_by_user_id).catch(err =>
          console.warn('Skill embedding refresh failed (non-blocking):', err)
        );
      }
    } else {
      await prisma.ticket.update({
        where: { id: params.id },
        data: { status: 'IN_PROGRESS', completed_at: null }
      });
    }

    return NextResponse.json({ success: true, rating });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    console.error('Verify ticket error:', error);
    return NextResponse.json({ error: 'Failed to verify ticket' }, { status: 500 });
  }
}
