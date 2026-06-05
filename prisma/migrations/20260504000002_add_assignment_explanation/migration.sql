-- Phase 3: async LLM explainer.
-- explanation: Gemini-written rationale for why this candidate was picked. Audit trail.
-- explanation_status: PENDING (queued) → COMPLETED (written) → FAILED (LLM error/timeout).
-- ai_disagreement: TRUE when Gemini's reasoning flags the heuristic's pick as questionable —
-- shown in admin/moderator UI but does NOT auto-reroute (human decides).

CREATE TYPE "ExplanationStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

ALTER TABLE "ticket_assignments"
    ADD COLUMN "explanation" TEXT,
    ADD COLUMN "explanation_status" "ExplanationStatus" NOT NULL DEFAULT 'PENDING',
    ADD COLUMN "ai_disagreement" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "explained_at" TIMESTAMP(3);

CREATE INDEX "ticket_assignments_explanation_status_idx"
    ON "ticket_assignments"("explanation_status");
