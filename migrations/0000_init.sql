-- The documents this service persists. Every statement is guarded, because instances that ran a
-- version before this folder existed already have the table: it was created imperatively on boot,
-- with no migration bookkeeping, so this migration has to be able to adopt what is already there.
CREATE TABLE IF NOT EXISTS "kern_collab"."documents" (
	"name" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"module" text NOT NULL,
	"type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"state" bytea NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documents_workspace_idx" ON "kern_collab"."documents" ("workspace_id","module","updated_at" DESC);
