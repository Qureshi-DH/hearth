ALTER TABLE "place_memberships" ADD COLUMN "settles_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "place_memberships" ADD COLUMN "quiet_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_settings" jsonb DEFAULT '{"timeZone":null,"clock":null,"quietHours":null,"mutedPeople":[]}'::jsonb NOT NULL;