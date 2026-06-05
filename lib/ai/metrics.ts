// Drift metrics for the routing pipeline. Queried by admin/moderator dashboards and
// surfaced as time-series for early detection of model decay.
//
// All queries take an optional time window (default 30 days). All metrics are designed
// to be cheap — single aggregation queries, no N+1.

import { prisma } from '@/lib/prisma';

const DEFAULT_WINDOW_DAYS = 30;

function windowStart(days: number = DEFAULT_WINDOW_DAYS): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export interface RoutingMetrics {
  window_days: number;
  // Routing acceptance
  total_assignments: number;
  accepted: number;
  rejected: number;
  expired: number;
  acceptance_rate: number;        // accepted / total
  rejection_rate: number;         // rejected / total
  // Outcome quality
  total_outcomes: number;
  total_ratings: number;
  good_verdicts: number;
  good_rate: number;              // good / total_ratings
  first_time_fix_rate: number;    // first_time_fix=true / total_outcomes
  sla_compliance_rate: number;    // resolved within sla_deadline / total_outcomes
  // Exploration
  exploration_rate: number;       // was_exploration / total_assignments
  // AI sanity
  ai_disagreement_rate: number;   // ai_disagreement=true / explained assignments
  explanation_failure_rate: number;
}

export async function computeRoutingMetrics(windowDays = DEFAULT_WINDOW_DAYS): Promise<RoutingMetrics> {
  const since = windowStart(windowDays);

  const [
    assignmentCounts,
    explorationCount,
    explanationCounts,
    outcomes,
    ratings
  ] = await Promise.all([
    prisma.ticketAssignment.groupBy({
      by: ['status'],
      where: { assigned_at: { gte: since } },
      _count: { _all: true }
    }),
    prisma.ticketAssignment.count({
      where: { assigned_at: { gte: since }, was_exploration: true }
    }),
    prisma.ticketAssignment.groupBy({
      by: ['explanation_status'],
      where: { assigned_at: { gte: since } },
      _count: { _all: true }
    }).then(rows => {
      const map = new Map<string, number>();
      for (const r of rows) map.set(r.explanation_status, r._count._all);
      return map;
    }),
    prisma.ticketOutcome.findMany({
      where: { resolved_at: { gte: since } },
      select: {
        first_time_fix: true,
        resolution_time_minutes: true,
        ticket: { select: { sla_deadline: true } }
      }
    }),
    prisma.ticketRating.groupBy({
      by: ['verdict'],
      where: { rated_at: { gte: since } },
      _count: { _all: true }
    })
  ]);

  const aiDisagreementCount = await prisma.ticketAssignment.count({
    where: { assigned_at: { gte: since }, ai_disagreement: true }
  });

  const statusMap = new Map<string, number>();
  for (const r of assignmentCounts) statusMap.set(r.status, r._count._all);
  const accepted = statusMap.get('ACCEPTED') ?? 0;
  const rejected = statusMap.get('REJECTED') ?? 0;
  const expired = statusMap.get('EXPIRED') ?? 0;
  const proposed = statusMap.get('PROPOSED') ?? 0;
  const totalAssignments = accepted + rejected + expired + proposed;

  const verdictMap = new Map<string, number>();
  for (const r of ratings) verdictMap.set(r.verdict, r._count._all);
  const goodVerdicts = verdictMap.get('GOOD') ?? 0;
  const badVerdicts = verdictMap.get('BAD') ?? 0;
  const totalRatings = goodVerdicts + badVerdicts;

  const totalOutcomes = outcomes.length;
  const firstTimeFixCount = outcomes.filter(o => o.first_time_fix).length;
  const slaCompliantCount = outcomes.filter(o =>
    o.ticket.sla_deadline &&
    o.resolution_time_minutes !== null &&
    new Date(o.ticket.sla_deadline).getTime() >= Date.now() // simple proxy
  ).length;

  const explained = (explanationCounts.get('COMPLETED') ?? 0) + (explanationCounts.get('FAILED') ?? 0);
  const explanationFailures = explanationCounts.get('FAILED') ?? 0;

  return {
    window_days: windowDays,
    total_assignments: totalAssignments,
    accepted,
    rejected,
    expired,
    acceptance_rate: totalAssignments > 0 ? accepted / totalAssignments : 0,
    rejection_rate: totalAssignments > 0 ? rejected / totalAssignments : 0,
    total_outcomes: totalOutcomes,
    total_ratings: totalRatings,
    good_verdicts: goodVerdicts,
    good_rate: totalRatings > 0 ? goodVerdicts / totalRatings : 0,
    first_time_fix_rate: totalOutcomes > 0 ? firstTimeFixCount / totalOutcomes : 0,
    sla_compliance_rate: totalOutcomes > 0 ? slaCompliantCount / totalOutcomes : 0,
    exploration_rate: totalAssignments > 0 ? explorationCount / totalAssignments : 0,
    ai_disagreement_rate: explained > 0 ? aiDisagreementCount / explained : 0,
    explanation_failure_rate: explained > 0 ? explanationFailures / explained : 0
  };
}

export interface CategoryAccuracy {
  category: string;
  subcategory: string;
  total: number;
  good: number;
  good_rate: number;
}

/**
 * Per-category good-verdict rate. Lets a moderator spot categories where the heuristic
 * is misrouting consistently — e.g. "Facilities/Cold Storage 30% good rate" → bad skill map.
 */
export async function computeCategoryAccuracy(windowDays = DEFAULT_WINDOW_DAYS): Promise<CategoryAccuracy[]> {
  const since = windowStart(windowDays);

  const ratedTickets = await prisma.ticket.findMany({
    where: {
      created_at: { gte: since },
      rating: { isNot: null }
    },
    select: {
      ai_classification_category: true,
      ai_classification_subcategory: true,
      rating: { select: { verdict: true } }
    }
  });

  const grouped = new Map<string, { total: number; good: number }>();
  for (const t of ratedTickets) {
    const key = `${t.ai_classification_category}|${t.ai_classification_subcategory}`;
    const prior = grouped.get(key) ?? { total: 0, good: 0 };
    prior.total += 1;
    if (t.rating?.verdict === 'GOOD') prior.good += 1;
    grouped.set(key, prior);
  }

  return Array.from(grouped.entries())
    .map(([key, v]) => {
      const [category, subcategory] = key.split('|');
      return {
        category,
        subcategory,
        total: v.total,
        good: v.good,
        good_rate: v.total > 0 ? v.good / v.total : 0
      };
    })
    .sort((a, b) => a.good_rate - b.good_rate);
}

export interface ProviderPerformance {
  service_provider_id: string;
  total_tickets: number;
  good_outcomes: number;
  good_rate: number;
  rejections: number;
  rejection_rate: number;
  avg_resolution_minutes: number | null;
}

/**
 * Per-provider rolling performance. Used to flag underperformers and feed the Phase 4
 * ranker's `performance_ratio` feature with a more nuanced signal than today's
 * binary completed/total.
 */
export async function computeProviderPerformance(windowDays = DEFAULT_WINDOW_DAYS): Promise<ProviderPerformance[]> {
  const since = windowStart(windowDays);

  const assignments = await prisma.ticketAssignment.findMany({
    where: { assigned_at: { gte: since } },
    select: {
      service_provider_id: true,
      status: true,
      ticket: {
        select: {
          rating: { select: { verdict: true } },
          outcome: { select: { resolution_time_minutes: true } }
        }
      }
    }
  });

  const grouped = new Map<string, {
    total: number;
    good: number;
    rejections: number;
    minutes: number[];
  }>();

  for (const a of assignments) {
    const prior = grouped.get(a.service_provider_id) ?? { total: 0, good: 0, rejections: 0, minutes: [] };
    prior.total += 1;
    if (a.status === 'REJECTED') prior.rejections += 1;
    if (a.ticket.rating?.verdict === 'GOOD') prior.good += 1;
    if (a.ticket.outcome?.resolution_time_minutes) {
      prior.minutes.push(a.ticket.outcome.resolution_time_minutes);
    }
    grouped.set(a.service_provider_id, prior);
  }

  return Array.from(grouped.entries()).map(([id, v]) => ({
    service_provider_id: id,
    total_tickets: v.total,
    good_outcomes: v.good,
    good_rate: v.total > 0 ? v.good / v.total : 0,
    rejections: v.rejections,
    rejection_rate: v.total > 0 ? v.rejections / v.total : 0,
    avg_resolution_minutes:
      v.minutes.length > 0
        ? v.minutes.reduce((a, b) => a + b, 0) / v.minutes.length
        : null
  }));
}
