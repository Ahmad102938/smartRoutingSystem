import { prisma } from '@/lib/prisma';
import { ServiceProvider, UserRole } from '@prisma/client';

interface AvailabilityState {
  requiredSkills: string[];
  storeLocation: { latitude: number; longitude: number };
  availableProviders?: ServiceProvider[];
  error?: string;
  processingStep?: string;
}

interface AvailableProvider extends ServiceProvider {
  distance?: number;
  availabilityScore?: number;
  skillMatchScore?: number;
  overallScore?: number;
}

export class AvailabilityAgent {
  async getAvailableProviders(
    requiredSkills: string[],
    storeLocation: { latitude: number; longitude: number }
  ): Promise<AvailableProvider[]> {
    try {
      console.log('Starting availability agent workflow...');
      
      // Step 1: Validate inputs
      console.log('Step 1: Validating inputs...');
      if (!Array.isArray(requiredSkills)) {
        console.warn('Invalid requiredSkills provided, using empty array');
        requiredSkills = [];
      }

      if (!storeLocation || 
          typeof storeLocation.latitude !== 'number' || 
          typeof storeLocation.longitude !== 'number') {
        throw new Error('Invalid store location provided');
      }

      // Step 2: Fetch all approved providers
      console.log('Step 2: Fetching approved service providers...');
      const allProviders = await prisma.serviceProvider.findMany({
        where: {
          status: 'APPROVED'
        },
        include: {
          users: {
            where: {
              role: 'SERVICE_PROVIDER',
              is_active: true
            }
          }
        }
      });

      console.log(`Found ${allProviders.length} approved providers`);

      // Step 3: Derive live load from TicketAssignment counts (not the stale current_load column).
      // Single GROUP BY avoids N+1; falls back to 0 for providers with no active assignments.
      console.log('Step 3: Deriving live load and filtering by capacity...');
      const providerIds = allProviders.map(p => p.id);
      const liveLoadRows = providerIds.length > 0
        ? await prisma.ticketAssignment.groupBy({
            by: ['service_provider_id'],
            where: {
              service_provider_id: { in: providerIds },
              status: { in: ['PROPOSED', 'ACCEPTED'] }
            },
            _count: { _all: true }
          })
        : [];
      const liveLoadByProvider = new Map<string, number>(
        liveLoadRows.map(r => [r.service_provider_id, r._count._all])
      );

      const capacityFiltered = allProviders
        .map(provider => {
          const liveLoad = liveLoadByProvider.get(provider.id) ?? 0;
          return { ...provider, current_load: liveLoad };
        })
        .filter(provider => provider.current_load < provider.capacity_per_day);

      console.log(`${capacityFiltered.length} providers have available capacity (live load)`);

      // Step 4: Calculate skill scores for all providers (don't filter out)
      console.log('Step 4: Calculating skill scores for all providers...');
      const providersWithSkills: AvailableProvider[] = capacityFiltered
        .filter(provider => {
          // Must have active users
          if (provider.users.length === 0) {
            return false;
          }
          return true; // Include all providers with active users
        })
        .map(provider => {
          // Calculate skill match score
          let skillMatchScore = 0.0; // Default to 0 for no match
          if (requiredSkills && requiredSkills.length > 0) {
            const matchedSkills = requiredSkills.filter(skill =>
              provider.skills.some(providerSkill =>
                providerSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(providerSkill.toLowerCase())
              )
            );
            skillMatchScore = matchedSkills.length / requiredSkills.length;
          } else {
            skillMatchScore = 0.5; // Neutral score when no skills required
          }

          return {
            ...provider,
            skillMatchScore
          };
        });

      console.log(`${providersWithSkills.length} providers available for assignment`);

      // Step 5: Calculate distances and availability scores
      console.log('Step 5: Calculating provider scores...');
      const scoredProviders: AvailableProvider[] = providersWithSkills.map(provider => {
        try {
          // Parse coordinates
          let coords: { latitude: number; longitude: number };
          
          if (typeof provider.primary_location_coordinates === 'string') {
            coords = JSON.parse(provider.primary_location_coordinates);
          } else {
            coords = provider.primary_location_coordinates as { latitude: number; longitude: number };
          }

          // Validate coordinates
          if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') {
            console.warn(`Invalid coordinates for provider ${provider.id}, using default distance`);
            coords = { latitude: 0, longitude: 0 };
          }

          const distance = this.calculateDistance(
            storeLocation.latitude,
            storeLocation.longitude,
            coords.latitude,
            coords.longitude
          );

          // Calculate availability score (0-1)
          const capacityUtilization = provider.current_load / Math.max(provider.capacity_per_day, 1);
          const availabilityScore = Math.max(0, 1 - capacityUtilization);

          // Calculate overall score (weighted combination)
          const distanceScore = Math.max(0, 1 - (distance / 100)); // Normalize distance (0-100km)
          const overallScore = (
            (availabilityScore * 0.4) + 
            (distanceScore * 0.3) + 
            ((provider.skillMatchScore || 0) * 0.3)
          );

          return {
            ...provider,
            distance,
            availabilityScore,
            overallScore
          };
        } catch (coordError) {
          console.error(`Error processing provider ${provider.id}:`, coordError);
          return {
            ...provider,
            distance: 999999,
            availabilityScore: 0,
            overallScore: 0
          };
        }
      });

      // Sort by overall score - include ALL providers, even with low scores
      const sortedProviders = scoredProviders
        .sort((a, b) => (b.overallScore || 0) - (a.overallScore || 0));

      console.log(`Final ranking: ${sortedProviders.length} providers (including low skill matches)`);
      sortedProviders.forEach((provider, index) => {
        console.log(`  ${index + 1}. ${provider.company_name} - Score: ${(provider.overallScore || 0).toFixed(2)}, Skills: ${provider.skills.join(', ')}`);
      });
      console.log('Availability agent completed successfully.');

      return sortedProviders;
    } catch (error) {
      console.error('Error in getAvailableProviders:', error);
      return [];
    }
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    try {
      if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
        console.warn('Invalid coordinates provided to calculateDistance');
        return 999999;
      }

      const R = 6371; // Earth's radius in kilometers
      const dLat = this.toRadians(lat2 - lat1);
      const dLon = this.toRadians(lon2 - lon1);
      const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      return isNaN(distance) ? 999999 : distance;
    } catch (error) {
      console.error('Error calculating distance:', error);
      return 999999;
    }
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

// Singleton instance for consistent state management
export const availabilityAgent = new AvailabilityAgent();