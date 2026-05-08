ALTER TABLE "messages" ADD COLUMN "to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_to_user_idx" ON "messages" USING btree ("to_user_id","created_at" DESC NULLS LAST);