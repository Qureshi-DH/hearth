ALTER TABLE "circle_members" ADD COLUMN "speed_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "circle_members" ADD COLUMN "low_battery_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "circle_members" ADD COLUMN "low_battery_notified_level" real;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "previous_rotated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "sessions_previous_refresh_token_hash_idx" ON "sessions" USING btree ("previous_refresh_token_hash");