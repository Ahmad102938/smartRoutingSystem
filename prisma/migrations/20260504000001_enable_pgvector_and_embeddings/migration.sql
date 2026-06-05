-- Phase 2: enable pgvector and add 384-dim embedding columns.
-- Embeddings are written by lib/ai/embeddings.ts using bge-small-en-v1.5 (local, no PII leakage).
-- HNSW indexes give us fast cosine similarity at 100K+ rows without performance tuning.

CREATE EXTENSION IF NOT EXISTS vector;

-- Ticket: embed (description + classification.category + subcategory).
ALTER TABLE "tickets" ADD COLUMN "embedding" vector(384);

-- User: embed rolling synthesis of "tickets this technician resolved successfully" once
-- we have TicketOutcome data accumulated. Until then, this stays NULL.
ALTER TABLE "users" ADD COLUMN "skill_embedding" vector(384);

-- Asset: embed (make + model + category + description). Filled when the asset is enriched
-- via /api/assets PUT — bare QR-only assets (just qr_code + store_id) skip embedding.
ALTER TABLE "assets" ADD COLUMN "embedding" vector(384);

-- HNSW indexes (fast approximate nearest neighbor). vector_cosine_ops matches our
-- similarity-agent's choice of cosine distance.
CREATE INDEX "tickets_embedding_hnsw_idx" ON "tickets" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "users_skill_embedding_hnsw_idx" ON "users" USING hnsw ("skill_embedding" vector_cosine_ops);
CREATE INDEX "assets_embedding_hnsw_idx" ON "assets" USING hnsw ("embedding" vector_cosine_ops);
