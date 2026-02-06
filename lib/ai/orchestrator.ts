import { classificationAgent } from './agents/classification-agent';
import { availabilityAgent } from './agents/availability-agent';
import { routingAgent } from './agents/routing-agent';
import { escalationAgent } from './agents/escalation-agent';
import { prisma } from '@/lib/prisma';
// Import TicketPriority and TicketStatus from Prisma client
import { TicketPriority, TicketStatus } from '@prisma/client';

//the core purpose of this orcastrator is to take a new problem (a "ticket"), understand it, and efficiently assign it to the best available service provider who can fix it. It also manages the entire lifecycle of the ticket after the initial assignment.

export class AIOrchestrator {
  async processNewTicket(ticketData: {
    description: string;
    store_id: string;
    reporter_user_id: string;
    location_in_store: string;
    qr_asset_id?: string;
  }) {
    try {
      // Step 1: Classify the issue
      console.log('Classifying issue...');
      const classification = await classificationAgent.classify(ticketData.description);

      // Step 2: Calculate SLA deadline
      const createdAt = new Date();
      const slaDeadline = escalationAgent.calculateSLADeadline(
        classification.priority as TicketPriority,
        createdAt
      );

      // Step 3: Create ticket in database
      console.log('Creating ticket...');
      const ticket = await prisma.ticket.create({
        data: {
          store_id: ticketData.store_id,
          reporter_user_id: ticketData.reporter_user_id,
          description: ticketData.description,
          qr_asset_id: ticketData.qr_asset_id,
          ai_classification_category: classification.category,
          ai_classification_subcategory: classification.subcategory,
          ai_priority: classification.priority as TicketPriority,
          location_in_store: ticketData.location_in_store,
          sla_deadline: slaDeadline,
          status: 'OPEN'
        },
        include: {
          store: true
        }
      });

      // Step 4: Get store location
      const storeLocation = ticket.store.location_coordinates as { latitude: number; longitude: number };

      // Step 5: Find available providers
      console.log('Finding available providers...');
      const requiredSkills = this.getRequiredSkills(classification.category, classification.subcategory);
      const availableProviders = await availabilityAgent.getAvailableProviders(
        requiredSkills,
        storeLocation
      );

      if (availableProviders.length === 0) {
        console.log('No available providers found - this should not happen with the updated availability agent');
        return {
          ticket,
          classification,
          assigned: false,
          reason: 'No service providers available in the system'
        };
      }

      // Check if any providers have good skill matches
      const providersWithGoodSkills = availableProviders.filter(p => (p.skillMatchScore || 0) > 0.5);
      const bestProvider = availableProviders[0];
      
      console.log(`\n📊 Provider Analysis:`);
      console.log(`- Total providers available: ${availableProviders.length}`);
      console.log(`- Providers with good skill matches (>50%): ${providersWithGoodSkills.length}`);
      console.log(`- Required skills: ${requiredSkills.join(', ')}`);
      
      if (providersWithGoodSkills.length === 0) {
        console.log(`⚠️  No providers with exact skill matches, but proceeding with best available provider`);
        console.log(`🎯 Best available provider: ${bestProvider.company_name}`);
        console.log(`   - Skill match: ${(bestProvider.skillMatchScore || 0) * 100}%`);
        console.log(`   - Overall score: ${(bestProvider.overallScore || 0).toFixed(2)}`);
        console.log(`   - Available skills: ${bestProvider.skills.join(', ')}`);
      } else {
        console.log(`✅ Found ${providersWithGoodSkills.length} providers with good skill matches`);
      }

      // Step 6: Route to best provider
      console.log('Routing to best provider...');
      const routing = await routingAgent.routeTicket(
        ticket.id,
        classification.category,
        classification.subcategory,
        classification.priority as TicketPriority,
        storeLocation,
        availableProviders
      );

      return {
        ticket,
        classification,
        assigned: true,
        assignedProvider: routing.providerId,
        routingScore: routing.score,
        reasoning: routing.reasoning
      };

    } catch (error) {
      console.error('Error processing ticket:', error);
      throw error;
    }
  }

  private getRequiredSkills(category: string, subcategory: string): string[] {
    const skillMap: Record<string, string[]> = {
      'Facilities_Cold Storage': ['Refrigeration', 'HVAC'],
      'Facilities_Electrical': ['Electrical'],
      'Facilities_Plumbing': ['Plumbing'],
      'Facilities_HVAC': ['HVAC'],
      'IT_POS Systems': ['POS Systems', 'IT Support'],
      'IT_Network': ['Network', 'IT Support'],
      'IT_Computers': ['IT Support', 'Computer Repair'],
      'Equipment_Shopping Carts': ['General Maintenance'],
      'Equipment_Shelving': ['General Maintenance'],
      'General_Maintenance': ['General Maintenance']
    };

    const key = `${category}_${subcategory}`;
    return skillMap[key] || ['General Maintenance'];
  }

  async handleTicketAcceptance(ticketId: string, providerId: string, empId: string, phoneNumber: string) {
    try {
      // Update ticket assignment
      await prisma.ticketAssignment.updateMany({
        where: {
          ticket_id: ticketId,
          service_provider_id: providerId,
          status: 'PROPOSED'
        },
        data: {
          status: 'ACCEPTED',
          accepted_at: new Date(),
          accepted_emp_id: empId,
          accepted_phone_number: phoneNumber
        }
      });

      // Update ticket status
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'IN_PROGRESS',
          accepted_at: new Date()
        }
      });

      console.log(`Ticket ${ticketId} accepted by provider ${providerId}`);
    } catch (error) {
      console.error('Error handling ticket acceptance:', error);
      throw error;
    }
  }

  async handleTicketRejection(ticketId: string, providerId: string, reason: string) {
    try {
      // Get service provider details for the remark
      const serviceProvider = await prisma.serviceProvider.findUnique({
        where: { id: providerId },
        select: { company_name: true }
      });

      // Update ticket assignment
      await prisma.ticketAssignment.updateMany({
        where: {
          ticket_id: ticketId,
          service_provider_id: providerId,
          status: 'PROPOSED'
        },
        data: {
          status: 'REJECTED',
          rejected_at: new Date(),
          rejection_reason: reason
        }
      });

      // Update ticket status to REJECTED_BY_TECH
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { status: 'REJECTED_BY_TECH' }
      });

      // Add a remark to notify the store about the rejection
      await prisma.remark.create({
        data: {
          ticket_id: ticketId,
          user_id: providerId, // Using provider ID as user ID for system remarks
          remark_text: `🚫 Ticket rejected by ${serviceProvider?.company_name || 'Service Provider'}. Reason: ${reason}`
        }
      });

      // Decrement provider load
      await prisma.serviceProvider.update({
        where: { id: providerId },
        data: {
          current_load: {
            decrement: 1
          }
        }
      });

      // Get ticket details for re-routing
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: {
          store: true
        }
      });

      if (!ticket) {
        throw new Error('Ticket not found');
      }

      // Find next available provider
      const storeLocation = ticket.store.location_coordinates as { latitude: number; longitude: number };
      const requiredSkills = this.getRequiredSkills(
        ticket.ai_classification_category,
        ticket.ai_classification_subcategory
      );

      const availableProviders = await availabilityAgent.getAvailableProviders(
        requiredSkills,
        storeLocation
      );

      // Filter out the provider who just rejected
      const otherProviders = availableProviders.filter(p => p.id !== providerId);

      if (otherProviders.length > 0) {
        // Re-route to next best provider
        await routingAgent.routeTicket(
          ticketId,
          ticket.ai_classification_category,
          ticket.ai_classification_subcategory,
          ticket.ai_priority,
          storeLocation,
          otherProviders
        );

        // Update ticket status back to ASSIGNED since it's been re-routed
        await prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'ASSIGNED' }
        });

        // Add remark about re-routing
        await prisma.remark.create({
          data: {
            ticket_id: ticketId,
            user_id: providerId, // Using provider ID as user ID for system remarks
            remark_text: `🔄 Ticket has been re-routed to another service provider.`
          }
        });
      } else {
        // No other providers available, mark for escalation
        await prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'ESCALATED' }
        });

        // Add remark about escalation
        await prisma.remark.create({
          data: {
            ticket_id: ticketId,
            user_id: providerId, // Using provider ID as user ID for system remarks
            remark_text: `⚠️ No available service providers found. Ticket has been escalated to management.`
          }
        });
      }

      console.log(`Ticket ${ticketId} rejected by provider ${providerId}, reason: ${reason}`);
    } catch (error) {
      console.error('Error handling ticket rejection:', error);
      throw error;
    }
  }

  async handleTicketCompletion(ticketId: string, providerId: string) {
    try {
      // Update ticket
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'COMPLETED'
          // Do not set completed_at yet
        }
      });

      // Decrement provider load
      await prisma.serviceProvider.update({
        where: { id: providerId },
        data: {
          current_load: {
            decrement: 1
          }
        }
      });

      console.log(`Ticket ${ticketId} marked as completed by provider ${providerId}`);
    } catch (error) {
      console.error('Error handling ticket completion:', error);
      throw error;
    }
  }
}

// Singleton instance
export const aiOrchestrator = new AIOrchestrator();