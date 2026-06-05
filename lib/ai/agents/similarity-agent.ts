// Semantic similarity over pgvector columns. Two query types:
//
//   1. Technician fit: given a ticket embedding, rank technicians by cosine similarity to
//      their skill_embedding (synthesized from past resolved tickets). Empty until
//      TicketOutcome data accumulates and the User.skill_embedding refresher runs.
//
//   2. Asset history: given a ticket's asset_id, return how many past tickets on the same
//      asset (or same asset model) were resolved with verdict=GOOD by each candidate provider/tech.
//
// Both produce features that get wired into the routing-agent's score blend.

import { prisma } from '@/lib/prisma';
import { embed, toVectorLiteral } from '../embeddings';

interface TechnicianFit {
  user_id: string;
  service_provider_id: string | null;
  similarity: number;
}

interface AssetHistoryFit {
  candidate_id: string; // service_provider_id OR user_id depending on candidate type
  good_outcomes: number;
  total_outcomes: number;
  good_ratio: number;
}

export class SimilarityAgent {
  /**
   * Rank technicians by cosine similarity of their skill_embedding to a ticket-text embedding.
   * Returns at most `limit` candidates with non-null skill_embedding. Falls back to an empty
   * array if pgvector is unavailable or no technicians have been profiled yet.
   */
  async rankTechniciansByFit(ticketText: string, limit = 25): Promise<TechnicianFit[]> {
    const vec = await embed(ticketText);
    if (!vec) return [];
    const literal = toVectorLiteral(vec);

    // <=> is pgvector's cosine distance; similarity = 1 - distance for normalized vectors.
    // Using $queryRawUnsafe because Prisma can't parameterize the vector cast cleanly.
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string;
      associated_provider_id: string | null;
      similarity: number;
    }>>(`
      SELECT id, associated_provider_id,
             1 - (skill_embedding <=> $1::vector) AS similarity
      FROM users
      WHERE skill_embedding IS NOT NULL
        AND role IN ('SERVICE_PROVIDER', 'TECHNICIAN')
        AND is_active = true
      ORDER BY skill_embedding <=> $1::vector
      LIMIT $2
    `, literal, limit);

    return rows.map(r => ({
      user_id: r.id,
      service_provider_id: r.associated_provider_id,
      similarity: Number(r.similarity)
    }));
  }

  /**
   * For a given asset, returns how each candidate (service_provider or user) has performed
   * on past tickets involving the same asset. "Good" = TicketRating.verdict='GOOD'.
   *
   * Also accepts a fallback model match — if make+model is set, includes tickets on different
   * assets of the same model.
   */
  async assetHistoryByCandidate(
    assetId: string | null,
    candidateProviderIds: string[],
    candidateUserIds: string[] = []
  ): Promise<Map<string, AssetHistoryFit>> {
    const result = new Map<string, AssetHistoryFit>();

    if (!assetId || (candidateProviderIds.length === 0 && candidateUserIds.length === 0)) {
      return result;
    }

    // Look up the asset's model so we can match same-model tickets too.
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, make: true, model: true }
    });

    const matchableAssetIds = await this.collectMatchableAssetIds(asset);

    if (matchableAssetIds.length === 0) return result;

    // Aggregate by service_provider_id and assigned_user_id from past tickets.
    const ticketAssignments = await prisma.ticketAssignment.findMany({
      where: {
        ticket: { asset_id: { in: matchableAssetIds } },
        status: 'ACCEPTED',
        OR: [
          ...(candidateProviderIds.length > 0 ? [{ service_provider_id: { in: candidateProviderIds } }] : []),
          ...(candidateUserIds.length > 0 ? [{ assigned_user_id: { in: candidateUserIds } }] : [])
        ]
      },
      select: {
        service_provider_id: true,
        assigned_user_id: true,
        ticket: { select: { rating: { select: { verdict: true } } } }
      }
    });

    for (const a of ticketAssignments) {
      const verdict = a.ticket.rating?.verdict;
      const keys = [a.service_provider_id, a.assigned_user_id].filter((k): k is string => !!k);
      for (const k of keys) {
        const prior = result.get(k) ?? { candidate_id: k, good_outcomes: 0, total_outcomes: 0, good_ratio: 0 };
        prior.total_outcomes += 1;
        if (verdict === 'GOOD') prior.good_outcomes += 1;
        prior.good_ratio = prior.total_outcomes > 0 ? prior.good_outcomes / prior.total_outcomes : 0;
        result.set(k, prior);
      }
    }

    return result;
  }

  private async collectMatchableAssetIds(
    asset: { id: string; make: string | null; model: string | null } | null
  ): Promise<string[]> {
    if (!asset) return [];
    if (!asset.make || !asset.model) return [asset.id];

    const sameModel = await prisma.asset.findMany({
      where: { make: asset.make, model: asset.model },
      select: { id: true }
    });
    return sameModel.map(a => a.id);
  }

  /**
   * Refresh a user's skill_embedding from their last N verified-good resolutions.
   * Called after a TicketRating with verdict=GOOD is written. Cheap (local model).
   */
  async refreshTechnicianSkillEmbedding(userId: string, lookbackTickets = 20): Promise<void> {
    const recentGood = await prisma.ticketOutcome.findMany({
      where: {
        resolved_by_user_id: userId,
        ticket: { rating: { verdict: 'GOOD' } }
      },
      orderBy: { resolved_at: 'desc' },
      take: lookbackTickets,
      select: { root_cause: true, technician_notes: true }
    });

    if (recentGood.length === 0) return;

    const corpus = recentGood
      .map(o => `${o.root_cause}\n${o.technician_notes}`)
      .join('\n\n')
      .slice(0, 8000); // cap to avoid bge token limit

    const vec = await embed(corpus);
    if (!vec) return;

    await prisma.$executeRawUnsafe(
      `UPDATE users SET skill_embedding = $1::vector WHERE id = $2`,
      toVectorLiteral(vec),
      userId
    );
  }

  /**
   * Generate the embedding for a freshly-created ticket and store it.
   * Called after orchestrator.processNewTicket creates the ticket row.
   */
  async embedTicket(ticketId: string, text: string): Promise<void> {
    const vec = await embed(text);
    if (!vec) return;

    await prisma.$executeRawUnsafe(
      `UPDATE tickets SET embedding = $1::vector WHERE id = $2`,
      toVectorLiteral(vec),
      ticketId
    );
  }
}

export const similarityAgent = new SimilarityAgent();
