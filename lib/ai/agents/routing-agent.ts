import { prisma } from '@/lib/prisma';
import { TicketPriority } from '@prisma/client';

interface ProviderScore {
  providerId: string;
  score: number;
  breakdown: {
    skillMatch: number;
    availability: number;
    proximity: number;
    performance: number;
    semanticSimilarity: number;
    assetHistory: number;
  };
  reasoning: string;
}

export class RoutingAgent {
  private calculateSkillMatch(providerSkills: string[], category: string, subcategory: string): number {
    const requiredSkills = this.getCategorySkills(category, subcategory);
    let totalScore = 0;
    let totalWeight = 0;

    for (const { skill, weight } of requiredSkills) {
      const hasSkill = providerSkills.some(providerSkill => 
        providerSkill.toLowerCase().includes(skill.toLowerCase()) ||
        skill.toLowerCase().includes(providerSkill.toLowerCase())
      );
      totalScore += hasSkill ? weight : 0;
      totalWeight += weight;
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  private getCategorySkills(category: string, subcategory: string): Array<{skill: string, weight: number}> {
    const skillMap: Record<string, Array<{skill: string, weight: number}>> = {
      'Facilities_Cold Storage': [
        { skill: 'Refrigeration', weight: 0.8 },
        { skill: 'HVAC', weight: 0.6 },
        { skill: 'Electrical', weight: 0.4 }
      ],
      'Facilities_Electrical': [
        { skill: 'Electrical', weight: 0.9 },
        { skill: 'General Maintenance', weight: 0.3 }
      ],
      'Facilities_Plumbing': [
        { skill: 'Plumbing', weight: 0.9 },
        { skill: 'General Maintenance', weight: 0.3 }
      ],
      'Facilities_HVAC': [
        { skill: 'HVAC', weight: 0.9 },
        { skill: 'Electrical', weight: 0.4 }
      ],
      'IT_POS Systems': [
        { skill: 'POS Systems', weight: 0.8 },
        { skill: 'IT Support', weight: 0.7 }
      ],
      'IT_Network': [
        { skill: 'Network', weight: 0.9 },
        { skill: 'IT Support', weight: 0.6 }
      ],
      'IT_Computers': [
        { skill: 'IT Support', weight: 0.8 },
        { skill: 'Computer Repair', weight: 0.7 }
      ],
      'Equipment_Shopping Carts': [
        { skill: 'General Maintenance', weight: 0.7 }
      ],
      'Equipment_Shelving': [
        { skill: 'General Maintenance', weight: 0.8 }
      ],
      'General_Maintenance': [
        { skill: 'General Maintenance', weight: 0.9 }
      ]
    };

    const key = `${category}_${subcategory}`;
    return skillMap[key] || [{ skill: 'General Maintenance', weight: 0.9 }];
  }

  private calculateProximityScore(distance: number): number {
    // Closer is better, max distance of 50km
    const maxDistance = 50;
    return Math.max(0, 1 - (distance / maxDistance));
  }

  private async calculatePerformanceScore(providerId: string): Promise<number> {
    try {
      // Get historical performance data
      const completedTickets = await prisma.ticket.count({
        where: {
          assigned_service_provider_id: providerId,
          status: 'COMPLETED'
        }
      });

      const totalTickets = await prisma.ticket.count({
        where: {
          assigned_service_provider_id: providerId
        }
      });

      if (totalTickets === 0) return 0.5; // Default score for new providers

      return completedTickets / totalTickets;
    } catch (error) {
      console.error('Error calculating performance score:', error);
      return 0.5; // Default score
    }
  }

  private async calculateProviderScore(provider: any, category: string, subcategory: string, priority: TicketPriority): Promise<ProviderScore> {
    // Skill matching score (0-1)
    const skillMatch = this.calculateSkillMatch(provider.skills, category, subcategory);

    // Availability score (0-1)
    const availability = 1 - (provider.current_load / provider.capacity_per_day);

    // Proximity score (0-1) - closer is better
    const proximity = this.calculateProximityScore(provider.distance || 0);

    // Performance score (0-1) - based on historical data
    const performance = await this.calculatePerformanceScore(provider.id);

    // Semantic similarity (0-1) — set by orchestrator.enrichWithSimilarityFeatures.
    // Defaults to 0 until a technician's skill_embedding is built from past good outcomes.
    const semanticSimilarity = Math.max(0, Math.min(1, provider.semantic_similarity ?? 0));

    // Asset history good ratio (0-1) — fraction of past tickets on this asset/model that
    // this provider resolved with a GOOD verdict. 0 when no history exists.
    const assetHistory = Math.max(0, Math.min(1, provider.asset_history_good_ratio ?? 0));

    // Base weights. Total = 1.0.
    const weights = {
      skillMatch: 0.30,
      availability: 0.15,
      proximity: 0.20,
      performance: 0.10,
      semanticSimilarity: 0.15,
      assetHistory: 0.10
    };

    // Priority adjustments — HIGH urgency favors fast-arrival features over learned signals.
    if (priority === 'HIGH') {
      weights.proximity += 0.10;
      weights.availability += 0.10;
      weights.skillMatch -= 0.05;
      weights.semanticSimilarity -= 0.10;
      weights.assetHistory -= 0.05;
    }

    const totalScore =
      skillMatch * weights.skillMatch +
      availability * weights.availability +
      proximity * weights.proximity +
      performance * weights.performance +
      semanticSimilarity * weights.semanticSimilarity +
      assetHistory * weights.assetHistory;

    const reasoning = `
Provider ${provider.company_name} scored ${(totalScore * 100).toFixed(1)}%:
- Skill Match: ${(skillMatch * 100).toFixed(1)}% (weight: ${weights.skillMatch})
- Availability: ${(availability * 100).toFixed(1)}% (${provider.current_load}/${provider.capacity_per_day} capacity)
- Proximity: ${(proximity * 100).toFixed(1)}% (${provider.distance?.toFixed(1)}km away)
- Performance: ${(performance * 100).toFixed(1)}% (historical avg)
- Semantic Similarity: ${(semanticSimilarity * 100).toFixed(1)}% (vs past resolved tickets)
- Asset History: ${(assetHistory * 100).toFixed(1)}% good outcomes on this asset/model (n=${provider.asset_history_total ?? 0})
Priority: ${priority}
    `.trim();

    return {
      providerId: provider.id,
      score: totalScore,
      breakdown: {
        skillMatch,
        availability,
        proximity,
        performance,
        semanticSimilarity,
        assetHistory
      },
      reasoning
    };
  }

  async routeTicket(
    ticketId: string,
    category: string,
    subcategory: string,
    priority: TicketPriority,
    storeLocation: { latitude: number; longitude: number },
    availableProviders: any[]
  ): Promise<{ providerId: string; score: number; reasoning: string; wasExploration: boolean }> {
    try {
      if (!availableProviders.length) {
        throw new Error('No available providers found');
      }

      const providerScores: ProviderScore[] = [];

      for (const provider of availableProviders) {
        const score = await this.calculateProviderScore(provider, category, subcategory, priority);
        providerScores.push(score);
      }

      providerScores.sort((a, b) => b.score - a.score);

      // Epsilon-greedy exploration: with probability EXPLORATION_RATE, pick uniformly
      // from the top 3 instead of strictly the top 1. Without this, the eventual learned
      // ranker only ever sees data from its own policy (selection-bias poisoning).
      const explorationRate = parseFloat(process.env.ROUTING_EXPLORATION_RATE ?? '0.1');
      const shouldExplore = providerScores.length >= 2 && Math.random() < explorationRate;
      let bestProvider: ProviderScore;
      if (shouldExplore) {
        const topK = providerScores.slice(0, Math.min(3, providerScores.length));
        bestProvider = topK[Math.floor(Math.random() * topK.length)];
      } else {
        bestProvider = providerScores[0];
      }

      // Counterfactual log: store top-5 candidates with their scores BEFORE the policy choice,
      // so a future learned ranker can train on what would have happened with each pick.
      const topCandidates = providerScores.slice(0, 5).map(p => ({
        provider_id: p.providerId,
        score: p.score,
        breakdown: p.breakdown
      }));

      await prisma.routingDecisionLog.create({
        data: {
          ticket_id: ticketId,
          picked_provider_id: bestProvider.providerId,
          was_exploration: shouldExplore,
          candidates: topCandidates,
          feature_vector: {
            category,
            subcategory,
            priority,
            store_location: storeLocation,
            candidate_count: providerScores.length
          }
        }
      });

      await prisma.ticketAssignment.create({
        data: {
          ticket_id: ticketId,
          service_provider_id: bestProvider.providerId,
          assignment_sequence: 1,
          status: 'PROPOSED',
          was_exploration: shouldExplore
        }
      });

      // Ticket.assigned_service_provider_id is kept as a denormalized cache for legacy reads
      // (9 call sites). Source of truth is the active TicketAssignment row; this field will
      // be removed in a follow-up sweep.
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'ASSIGNED',
          assigned_service_provider_id: bestProvider.providerId,
          assigned_at: new Date()
        }
      });

      return {
        providerId: bestProvider.providerId,
        score: bestProvider.score,
        reasoning: bestProvider.reasoning,
        wasExploration: shouldExplore
      };

    } catch (error) {
      console.error('Routing error:', error);
      throw error;
    }
  }
}

// Singleton instance
export const routingAgent = new RoutingAgent();