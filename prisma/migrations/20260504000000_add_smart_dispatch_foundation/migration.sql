-- Smart Dispatch foundation: Phase 0 + Phase 1 schema additions.
-- Adds: Asset, TechnicianSkill, TicketOutcome, TicketRating, RoutingDecisionLog
-- Extends: TicketAssignment (assigned_user_id, was_exploration), Ticket (asset_id), UserRole (TECHNICIAN)
-- Backfills existing Ticket.qr_asset_id values into Asset rows.

-- ─────────────────────────────────────────────────────────────────────────
-- Enum extensions
-- ─────────────────────────────────────────────────────────────────────────

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'TECHNICIAN';

CREATE TYPE "SkillProficiency" AS ENUM ('NOVICE', 'COMPETENT', 'EXPERT');
CREATE TYPE "RatingVerdict" AS ENUM ('GOOD', 'BAD');

-- ─────────────────────────────────────────────────────────────────────────
-- Asset (equipment registered via QR code)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "assets" (
    "id"            TEXT NOT NULL,
    "qr_code"       TEXT NOT NULL,
    "store_id"      TEXT NOT NULL,
    "category"      TEXT,
    "make"          TEXT,
    "model"         TEXT,
    "install_date"  TIMESTAMP(3),
    "description"   TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assets_qr_code_key" ON "assets"("qr_code");
CREATE INDEX "assets_store_id_idx" ON "assets"("store_id");

ALTER TABLE "assets"
    ADD CONSTRAINT "assets_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Ticket: link to Asset
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "tickets" ADD COLUMN "asset_id" TEXT;
CREATE INDEX "tickets_asset_id_idx" ON "tickets"("asset_id");
ALTER TABLE "tickets"
    ADD CONSTRAINT "tickets_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Backfill: every existing ticket with a qr_asset_id gets an Asset row.
-- One Asset per (store_id, qr_code) — earliest ticket wins on first_seen_at.
-- ─────────────────────────────────────────────────────────────────────────

INSERT INTO "assets" ("id", "qr_code", "store_id", "first_seen_at")
SELECT
    -- cuid-shaped ID; gen_random_uuid() text is acceptable as a unique opaque id
    'asset_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
    qr_asset_id,
    store_id,
    MIN(created_at)
FROM "tickets"
WHERE qr_asset_id IS NOT NULL AND qr_asset_id <> ''
GROUP BY qr_asset_id, store_id;

UPDATE "tickets" t
SET "asset_id" = a."id"
FROM "assets" a
WHERE t.qr_asset_id = a.qr_code
  AND t.store_id = a.store_id
  AND t.asset_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- TicketAssignment: per-technician target + exploration flag
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE "ticket_assignments"
    ADD COLUMN "assigned_user_id" TEXT,
    ADD COLUMN "was_exploration" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ticket_assignments_assigned_user_id_status_idx"
    ON "ticket_assignments"("assigned_user_id", "status");
CREATE INDEX "ticket_assignments_service_provider_id_status_idx"
    ON "ticket_assignments"("service_provider_id", "status");

ALTER TABLE "ticket_assignments"
    ADD CONSTRAINT "ticket_assignments_assigned_user_id_fkey"
    FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- TechnicianSkill (per-user skills with proficiency)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "technician_skills" (
    "id"               TEXT NOT NULL,
    "user_id"          TEXT NOT NULL,
    "skill"            TEXT NOT NULL,
    "proficiency"      "SkillProficiency" NOT NULL DEFAULT 'COMPETENT',
    "years_experience" INTEGER,
    "last_used_at"     TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "technician_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_skills_user_id_skill_key"
    ON "technician_skills"("user_id", "skill");
CREATE INDEX "technician_skills_skill_idx"
    ON "technician_skills"("skill");

ALTER TABLE "technician_skills"
    ADD CONSTRAINT "technician_skills_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- TicketOutcome (technician resolution form)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "ticket_outcomes" (
    "id"                       TEXT NOT NULL,
    "ticket_id"                TEXT NOT NULL,
    "resolved_by_user_id"      TEXT NOT NULL,
    "resolution_time_minutes"  INTEGER NOT NULL,
    "first_time_fix"           BOOLEAN NOT NULL DEFAULT true,
    "root_cause"               TEXT NOT NULL,
    "parts_used"               JSONB,
    "technician_notes"         TEXT NOT NULL,
    "was_reassigned"           BOOLEAN NOT NULL DEFAULT false,
    "reassignment_count"       INTEGER NOT NULL DEFAULT 0,
    "resolved_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_outcomes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_outcomes_ticket_id_key" ON "ticket_outcomes"("ticket_id");
CREATE INDEX "ticket_outcomes_resolved_by_user_id_idx" ON "ticket_outcomes"("resolved_by_user_id");

ALTER TABLE "ticket_outcomes"
    ADD CONSTRAINT "ticket_outcomes_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_outcomes"
    ADD CONSTRAINT "ticket_outcomes_resolved_by_user_id_fkey"
    FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- TicketRating (moderator verification)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "ticket_ratings" (
    "id"                  TEXT NOT NULL,
    "ticket_id"           TEXT NOT NULL,
    "moderator_user_id"   TEXT NOT NULL,
    "verdict"             "RatingVerdict" NOT NULL,
    "tags"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "comment"             TEXT,
    "rated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_ratings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_ratings_ticket_id_key" ON "ticket_ratings"("ticket_id");
CREATE INDEX "ticket_ratings_verdict_idx" ON "ticket_ratings"("verdict");

ALTER TABLE "ticket_ratings"
    ADD CONSTRAINT "ticket_ratings_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_ratings"
    ADD CONSTRAINT "ticket_ratings_moderator_user_id_fkey"
    FOREIGN KEY ("moderator_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- RoutingDecisionLog (counterfactual logging — top-K candidates per ticket)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE "routing_decision_logs" (
    "id"                 TEXT NOT NULL,
    "ticket_id"          TEXT NOT NULL,
    "picked_provider_id" TEXT,
    "picked_user_id"     TEXT,
    "was_exploration"    BOOLEAN NOT NULL DEFAULT false,
    "candidates"         JSONB NOT NULL,
    "feature_vector"     JSONB,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "routing_decision_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "routing_decision_logs_ticket_id_idx" ON "routing_decision_logs"("ticket_id");
CREATE INDEX "routing_decision_logs_created_at_idx" ON "routing_decision_logs"("created_at");

ALTER TABLE "routing_decision_logs"
    ADD CONSTRAINT "routing_decision_logs_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
