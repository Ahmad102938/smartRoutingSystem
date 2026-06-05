import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { requirePermission, getTicketContext } from '@/lib/auth/rbac';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const ResolveTicketSchema = z.object({
  resolution_time_minutes: z.number().int().positive(),
  first_time_fix: z.boolean().default(true),
  root_cause: z.string().min(3).max(500),
  technician_notes: z.string().min(1).max(5000),
  parts_used: z.array(z.object({
    name: z.string(),
    quantity: z.number().int().positive(),
    cost: z.number().nonnegative().optional()
  })).optional()
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
    await requirePermission('ticket', 'resolve', context);

    const body = await request.json();
    const data = ResolveTicketSchema.parse(body);

    const ticket = await prisma.ticket.findUnique({
      where: { id: params.id },
      include: { assignments: { orderBy: { assigned_at: 'desc' } } }
    });
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const reassignmentCount = Math.max(0, ticket.assignments.length - 1);

    const outcome = await prisma.ticketOutcome.upsert({
      where: { ticket_id: params.id },
      update: {
        resolution_time_minutes: data.resolution_time_minutes,
        first_time_fix: data.first_time_fix,
        root_cause: data.root_cause,
        technician_notes: data.technician_notes,
        parts_used: data.parts_used ?? undefined,
        was_reassigned: reassignmentCount > 0,
        reassignment_count: reassignmentCount
      },
      create: {
        ticket_id: params.id,
        resolved_by_user_id: session.user.id,
        resolution_time_minutes: data.resolution_time_minutes,
        first_time_fix: data.first_time_fix,
        root_cause: data.root_cause,
        technician_notes: data.technician_notes,
        parts_used: data.parts_used ?? undefined,
        was_reassigned: reassignmentCount > 0,
        reassignment_count: reassignmentCount
      }
    });

    await prisma.ticket.update({
      where: { id: params.id },
      data: {
        status: 'COMPLETED',
        completed_at: new Date()
      }
    });

    return NextResponse.json({ success: true, outcome });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.errors }, { status: 400 });
    }
    console.error('Resolve ticket error:', error);
    return NextResponse.json({ error: 'Failed to resolve ticket' }, { status: 500 });
  }
}
