ALTER TABLE "sos_alerts" ADD COLUMN "live_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- An alert raised before the column held its phone on Live from when it was
-- raised, and an open one nobody resolved is counted from then too.
UPDATE "sos_alerts" SET "live_from" = "started_at";
