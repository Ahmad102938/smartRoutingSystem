// Single source of truth for routing features. Used at:
//   - Request time: orchestrator → enriched candidate → buildFeatures(candidate, ticket) → score
//   - Training time: exporter joins RoutingDecisionLog × TicketRating × TicketOutcome,
//                     calls buildFeatures with the same inputs, writes to a parquet/JSONL file.
//
// Keeping these aligned is critical — train/serve skew is the #1 source of silent ML failures.
// Every feature defined here MUST be derivable from the same inputs in both contexts.

export interface RoutingFeatures {
  // Deterministic features (always available)
  skill_match: number;          // 0..1, fuzzy substring match
  distance_km: number;          // Haversine
  distance_score: number;       // 1 - min(distance/50, 1)
  availability: number;         // 1 - load/capacity
  performance_ratio: number;    // historical completed/total
  priority_high: 0 | 1;
  priority_medium: 0 | 1;
  priority_low: 0 | 1;

  // Phase-2 semantic features (default 0 until embeddings populate)
  semantic_similarity: number;  // cosine sim(ticket, technician.skill_embedding)
  asset_history_good_ratio: number;  // GOOD outcomes / total on this asset/model
  asset_history_total: number;       // raw count for confidence weighting

  // Behavioral features
  was_exploration: 0 | 1;       // policy explored vs exploited
  hour_of_day: number;          // 0..23
  day_of_week: number;          // 0..6 (Sunday=0)
  current_load_count: number;   // raw active assignments at decision time
  recent_rejections: number;    // last 30 days, this provider
}

export function buildFeatures(input: {
  category: string;
  subcategory: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  store_location: { latitude: number; longitude: number };
  provider: {
    id: string;
    skills: string[];
    distance?: number;
    current_load: number;
    capacity_per_day: number;
    semantic_similarity?: number;
    asset_history_good_ratio?: number;
    asset_history_total?: number;
  };
  performance_ratio: number;     // pre-computed by caller
  recent_rejections: number;     // pre-computed by caller
  was_exploration: boolean;
  decision_time?: Date;
}): RoutingFeatures {
  const t = input.decision_time ?? new Date();
  const distance = input.provider.distance ?? 0;

  return {
    skill_match: skillMatchScore(input.provider.skills, input.category, input.subcategory),
    distance_km: distance,
    distance_score: Math.max(0, 1 - distance / 50),
    availability: 1 - input.provider.current_load / Math.max(1, input.provider.capacity_per_day),
    performance_ratio: input.performance_ratio,
    priority_high: input.priority === 'HIGH' ? 1 : 0,
    priority_medium: input.priority === 'MEDIUM' ? 1 : 0,
    priority_low: input.priority === 'LOW' ? 1 : 0,
    semantic_similarity: clamp01(input.provider.semantic_similarity ?? 0),
    asset_history_good_ratio: clamp01(input.provider.asset_history_good_ratio ?? 0),
    asset_history_total: input.provider.asset_history_total ?? 0,
    was_exploration: input.was_exploration ? 1 : 0,
    hour_of_day: t.getHours(),
    day_of_week: t.getDay(),
    current_load_count: input.provider.current_load,
    recent_rejections: input.recent_rejections
  };
}

function skillMatchScore(providerSkills: string[], category: string, subcategory: string): number {
  // Mirrors routing-agent.calculateSkillMatch but kept self-contained for training reuse.
  const required = `${category} ${subcategory}`.toLowerCase().split(/\s+/);
  const skillsLower = providerSkills.map(s => s.toLowerCase());
  const hits = required.filter(token =>
    skillsLower.some(skill => skill.includes(token) || token.includes(skill))
  );
  return required.length > 0 ? hits.length / required.length : 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
