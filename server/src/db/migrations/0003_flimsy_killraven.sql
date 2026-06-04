DROP INDEX "location_points_recorded_idx";--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "check_ins_user_idx" ON "check_ins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "check_ins_place_idx" ON "check_ins" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_outbox_session_idx" ON "notification_outbox" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "place_events_user_idx" ON "place_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trips_start_place_idx" ON "trips" USING btree ("start_place_id");--> statement-breakpoint
CREATE INDEX "trips_end_place_idx" ON "trips" USING btree ("end_place_id");