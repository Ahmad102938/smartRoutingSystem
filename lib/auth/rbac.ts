import { UserRole } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from './config';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export interface Permission {
  resource: string;
  action: string;
  conditions?: Record<string, any>;
}

export const PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.STORE_REGISTER]: [
    { resource: 'ticket', action: 'create' },
    { resource: 'ticket', action: 'read', conditions: { own_store: true } },
    { resource: 'ticket', action: 'update', conditions: { own_store: true, status: 'OPEN' } },
    { resource: 'profile', action: 'read' },
    { resource: 'profile', action: 'update' }
  ],
  [UserRole.SERVICE_PROVIDER]: [
    { resource: 'ticket', action: 'read', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'update', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'accept', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'reject', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'complete', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'resolve', conditions: { assigned_to_self: true } },
    { resource: 'remark', action: 'create', conditions: { assigned_to_self: true } },
    { resource: 'profile', action: 'read' },
    { resource: 'profile', action: 'update' },
    { resource: 'capacity', action: 'update' }
  ],
  [UserRole.TECHNICIAN]: [
    { resource: 'ticket', action: 'read', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'update', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'accept', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'reject', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'complete', conditions: { assigned_to_self: true } },
    { resource: 'ticket', action: 'resolve', conditions: { assigned_to_self: true } },
    { resource: 'remark', action: 'create', conditions: { assigned_to_self: true } },
    { resource: 'profile', action: 'read' },
    { resource: 'profile', action: 'update' },
    { resource: 'skill', action: 'update', conditions: { own_profile: true } }
  ],
  [UserRole.MODERATOR]: [
    { resource: 'ticket', action: 'read', conditions: { own_store: true } },
    { resource: 'ticket', action: 'update', conditions: { own_store: true } },
    { resource: 'ticket', action: 'verify', conditions: { own_store: true } },
    { resource: 'service_provider', action: 'approve' },
    { resource: 'service_provider', action: 'reject' },
    { resource: 'service_provider', action: 'read' },
    { resource: 'analytics', action: 'read', conditions: { own_store: true } },
    { resource: 'profile', action: 'read' },
    { resource: 'profile', action: 'update' },
    { resource: 'skill', action: 'update' }
  ],
  [UserRole.ADMIN]: [
    { resource: '*', action: '*' } // Admin has all permissions
  ]
};

export async function hasPermission(
  userRole: UserRole,
  resource: string,
  action: string,
  context?: Record<string, any>
): Promise<boolean> {
  const userPermissions = PERMISSIONS[userRole];
  
  // Check for wildcard permission (admin)
  if (userPermissions.some(p => p.resource === '*' && p.action === '*')) {
    return true;
  }

  // Check for specific permission
  const permission = userPermissions.find(p => 
    (p.resource === resource || p.resource === '*') && 
    (p.action === action || p.action === '*')
  );

  if (!permission) {
    return false;
  }

  // Check conditions if they exist
  if (permission.conditions && context) {
    for (const [condition, value] of Object.entries(permission.conditions)) {
      if (context[condition] !== value) {
        return false;
      }
    }
  }

  return true;
}

export async function requireAuth(req?: NextRequest) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    throw new Error('Unauthorized');
  }

  return session.user;
}

export async function requirePermission(
  resource: string,
  action: string,
  context?: Record<string, any>
) {
  const user = await requireAuth();
  
  const allowed = await hasPermission(user.role, resource, action, context);
  
  if (!allowed) {
    throw new Error('Forbidden');
  }

  return user;
}

export async function getTicketContext(ticketId: string, user: any) {
  // Source of truth for ownership is the active TicketAssignment row, not the denormalized
  // Ticket.assigned_service_provider_id (which doesn't capture per-technician routing).
  // We accept assignment by either the user's company OR the user themselves.
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      assignments: {
        where: { status: { in: ['PROPOSED', 'ACCEPTED'] } },
        orderBy: { assigned_at: 'desc' },
        take: 1
      }
    }
  });
  if (!ticket) return {};

  const active = ticket.assignments[0];
  const myProviderId = user.associated_provider_id || user.associated_entity_id;
  const myUserId = user.id;

  const assignedToMyCompany = active && active.service_provider_id === myProviderId;
  const assignedToMePersonally = active && active.assigned_user_id === myUserId;
  // Fallback to denormalized field for legacy tickets where no active assignment row exists.
  const legacyOwnership = !active && ticket.assigned_service_provider_id === myProviderId;

  return {
    assigned_to_self: Boolean(assignedToMyCompany || assignedToMePersonally || legacyOwnership),
    own_store: ticket.store_id === (user.associated_store_id || user.associated_entity_id)
  };
}