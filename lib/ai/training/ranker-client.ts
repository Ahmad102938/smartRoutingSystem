// Node client for the Python ranker sidecar. The sidecar holds an XGBoost LambdaRank model
// in memory and returns a score per candidate. We communicate over loopback HTTP to keep the
// Node bundle small and let the data team iterate independently.
//
// Behavior:
//   - If RANKER_SIDECAR_URL env is unset OR the sidecar errors/times out, falls back to the
//     deterministic heuristic score (caller's responsibility — this client just throws).
//   - Times out after 100ms; routing must not block waiting for the sidecar.
//
// Gating: the routing-agent only consults this when ENABLE_LEARNED_RANKER=1 in env. Until
// ~1000 labeled tickets exist, the model is undertrained and the heuristic wins.

import type { RoutingFeatures } from './feature-builder';

interface RankRequest {
  features: RoutingFeatures[];
  request_id?: string;
}

interface RankResponse {
  scores: number[];
  model_version: string;
}

const SIDECAR_URL = process.env.RANKER_SIDECAR_URL ?? '';
const TIMEOUT_MS = Number(process.env.RANKER_TIMEOUT_MS ?? '100');

export class RankerClient {
  enabled(): boolean {
    return process.env.ENABLE_LEARNED_RANKER === '1' && SIDECAR_URL !== '';
  }

  async rank(features: RoutingFeatures[]): Promise<number[]> {
    if (!this.enabled()) {
      throw new Error('Ranker client disabled');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(`${SIDECAR_URL}/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features } as RankRequest),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`Ranker sidecar returned ${res.status}`);
      }
      const body: RankResponse = await res.json();
      if (!Array.isArray(body.scores) || body.scores.length !== features.length) {
        throw new Error('Ranker returned malformed response');
      }
      return body.scores;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const rankerClient = new RankerClient();
