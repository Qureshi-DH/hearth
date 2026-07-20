ALTER TABLE "notification_outbox" ADD COLUMN "silent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_presence" ADD COLUMN "wake_requested_at" timestamp with time zone;