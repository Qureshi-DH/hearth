CREATE TABLE "circle_removals" (
	"circle_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circle_removals_circle_id_user_id_pk" PRIMARY KEY("circle_id","user_id")
);
--> statement-breakpoint
DROP INDEX "sessions_previous_refresh_token_hash_idx";--> statement-breakpoint
DROP INDEX "sessions_user_device_key";--> statement-breakpoint
ALTER TABLE "circle_members" ADD COLUMN "precise_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "spent_refresh" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "spent_refresh" = jsonb_build_array(jsonb_build_object(
	'h', "previous_refresh_token_hash",
	'at', to_char("previous_rotated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	'retried', false
)) WHERE "previous_refresh_token_hash" IS NOT NULL AND "previous_rotated_at" IS NOT NULL;--> statement-breakpoint
UPDATE "circle_members" cm SET "precise_since" = CASE
	WHEN cm."sharing_state" = 'precise' THEN greatest(
		(SELECT max(e."occurred_at") FROM "events" e
			WHERE e."circle_id" = cm."circle_id" AND e."actor_user_id" = cm."user_id"
			AND e."type" IN ('sharing_paused', 'sharing_resumed')),
		(SELECT max(s."started_at") FROM "sos_alerts" s
			WHERE s."circle_id" = cm."circle_id" AND s."user_id" = cm."user_id")
	)
	WHEN cm."sharing_state" = 'paused' AND cm."paused_until" IS NOT NULL
		AND coalesce(cm."resume_to_state", 'precise') = 'precise' THEN cm."paused_until"
	ELSE NULL
END;--> statement-breakpoint
ALTER TABLE "circle_removals" ADD CONSTRAINT "circle_removals_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "circle_removals" ADD CONSTRAINT "circle_removals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_spent_refresh_idx" ON "sessions" USING gin ("spent_refresh");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_user_device_live_key" ON "sessions" USING btree ("user_id","device_id") WHERE revoked_at is null;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "previous_refresh_token_hash";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "previous_rotated_at";