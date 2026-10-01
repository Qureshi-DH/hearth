DROP INDEX "notification_outbox_user_idx";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "group_title" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "group_line" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "group_thread" bigint;--> statement-breakpoint
CREATE INDEX "notification_outbox_group_idx" ON "notification_outbox" USING btree ("user_id","group_key");