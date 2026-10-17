CREATE TABLE "live_watches" (
	"user_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"circle_id" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_watches_user_id_viewer_id_pk" PRIMARY KEY("user_id","viewer_id")
);
--> statement-breakpoint
ALTER TABLE "user_presence" ADD COLUMN "device_id" text;--> statement-breakpoint
ALTER TABLE "live_watches" ADD CONSTRAINT "live_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_watches" ADD CONSTRAINT "live_watches_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_watches" ADD CONSTRAINT "live_watches_circle_id_circles_id_fk" FOREIGN KEY ("circle_id") REFERENCES "public"."circles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_watches_viewer_idx" ON "live_watches" USING btree ("viewer_id");--> statement-breakpoint
CREATE INDEX "live_watches_circle_idx" ON "live_watches" USING btree ("circle_id");