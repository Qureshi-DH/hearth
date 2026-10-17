CREATE TABLE "push_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "check_ins" ADD COLUMN "shared_as" text;--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_tickets_created_idx" ON "push_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "push_tickets_session_idx" ON "push_tickets" USING btree ("session_id");