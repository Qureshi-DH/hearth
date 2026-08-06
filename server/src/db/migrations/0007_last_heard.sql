ALTER TABLE "user_presence" ADD COLUMN "last_heard_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_presence" ADD COLUMN "wake_count" integer DEFAULT 0 NOT NULL;