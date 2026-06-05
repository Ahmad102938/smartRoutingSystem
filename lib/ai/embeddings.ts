// Local embedding generator using bge-small-en-v1.5 (384 dims) via @xenova/transformers.
// Runs entirely in Node — no network calls, no PII leakage to third-party services.
//
// Model is lazily loaded on first call (~30MB download cached to ~/.cache/xenova on first run,
// then ~2s warm-load per process), and the pipeline is reused across calls.

type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: 'none' | 'mean' | 'cls'; normalize?: boolean }
) => Promise<{ data: Float32Array | number[] }>;

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const EMBEDDING_DIM = 384;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // Suppress remote model warnings — local cache is fine.
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      const extractor = await pipeline('feature-extraction', MODEL_NAME);
      return extractor as unknown as FeatureExtractionPipeline;
    })();
  }
  return pipelinePromise;
}

/**
 * Generate a 384-dim embedding for a single piece of text.
 * Returns a plain number[] suitable for serializing into pgvector via $executeRaw.
 *
 * Empty/whitespace input returns null — callers should treat null as "no embedding"
 * and skip writing to the DB.
 */
export async function embed(text: string): Promise<number[] | null> {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  const extractor = await getPipeline();
  const output = await extractor(trimmed, { pooling: 'mean', normalize: true });
  const arr = Array.from(output.data as Float32Array);
  if (arr.length !== EMBEDDING_DIM) {
    throw new Error(`Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${arr.length}`);
  }
  return arr;
}

/**
 * Format a number[] embedding as a pgvector literal: '[0.1,0.2,...]'.
 * Use with prisma.$executeRaw`UPDATE ... SET embedding = ${vec}::vector` — but Prisma's
 * tagged-template binding handles the cast for us; this helper is for raw SQL strings only.
 */
export function toVectorLiteral(vec: number[]): string {
  return '[' + vec.map(n => n.toFixed(6)).join(',') + ']';
}

export const EMBEDDING_DIMENSION = EMBEDDING_DIM;
