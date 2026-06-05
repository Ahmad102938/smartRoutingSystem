import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { requirePermission } from '@/lib/auth/rbac';
import { aiOrchestrator } from '@/lib/ai/orchestrator';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { Prisma, TicketPriority, TicketStatus } from '@prisma/client';

const CreateTicketSchema = z.object({
  description: z.string().min(10).max(1000),
  location_in_store: z.string().min(1).max(100),
  qr_asset_id: z.string().optional()
});

type TicketWhere = Prisma.TicketWhereInput;

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check permissions
    await requirePermission('ticket', 'create');

    const body = await request.json();
    const validatedData = CreateTicketSchema.parse(body);

    // Debug: Log session user data
    console.log('Session user:', {
      id: session.user.id,
      role: session.user.role,
      associated_store_id: session.user.associated_store_id
    });

    // Validate that the store exists
    const storeId = session.user.associated_store_id;
    if (!storeId) {
      return NextResponse.json({ error: 'No store associated with user' }, { status: 400 });
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId }
    });

    if (!store) {
      console.error(`Store with ID ${storeId} not found`);
      return NextResponse.json({ error: 'Store not found' }, { status: 404 });
    }

    console.log('Found store:', { id: store.id, name: store.name });

    // Process ticket with AI orchestrator
    const result = await aiOrchestrator.processNewTicket({
      description: validatedData.description,
      location_in_store: validatedData.location_in_store,
      qr_asset_id: validatedData.qr_asset_id,
      store_id: storeId,
      reporter_user_id: session.user.id
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Create ticket error:', error);
    return NextResponse.json(
      { error: 'Failed to create ticket' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const priority = searchParams.get('priority');

    let whereClause: TicketWhere = {};

    // Apply role-based filtering
    if (session.user.role === 'STORE_REGISTER') {
      whereClause.store_id = session.user.associated_store_id;
    } else if (session.user.role === 'SERVICE_PROVIDER') {
      // Show tickets where the user's company is assigned OR the user themselves is the
      // named technician on an active assignment. Source of truth is TicketAssignment;
      // the denormalized Ticket.assigned_service_provider_id is no longer the filter.
      // (TECHNICIAN role users will be handled here once the next-auth types are extended.)
      const providerId = session.user.associated_provider_id;
      const orFilters: Prisma.TicketAssignmentWhereInput[] = [];
      if (providerId) orFilters.push({ service_provider_id: providerId });
      orFilters.push({ assigned_user_id: session.user.id });
      whereClause.assignments = { some: { OR: orFilters } };
    } else if (session.user.role === 'MODERATOR') {
      // Get tickets for stores moderated by this user
      const moderatedStores = await prisma.store.findMany({
        where: { moderator_user_id: session.user.id },
        select: { id: true }
      });
      whereClause.store_id = {
        in: moderatedStores.map(s => s.id)
      };
    }
    // Admin sees all tickets (no additional filtering)

    // Apply filters
    if (status && status !== 'all') {
      whereClause.status = status.toUpperCase() as TicketStatus;
    }
    if (priority && priority !== 'all') {
      whereClause.ai_priority = priority.toUpperCase() as TicketPriority;
    }

    const tickets = await prisma.ticket.findMany({
      where: whereClause,
      include: {
        store: true,
        reporter: {
          select: { id: true, username: true, email: true }
        },
        assigned_provider: {
          select: { id: true, company_name: true, skills: true }
        },
        assignments: {
          orderBy: { assigned_at: 'desc' },
          take: 1,
          select: {
            accepted_emp_id: true,
            accepted_phone_number: true,
            rejection_reason: true,
            status: true
          }
        },
        remarks: {
          orderBy: { created_at: 'desc' },
          include: {
            user: {
              select: { id: true, username: true, role: true }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    return NextResponse.json(tickets);
  } catch (error) {
    console.error('Get tickets error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tickets' },
      { status: 500 }
    );
  }
}