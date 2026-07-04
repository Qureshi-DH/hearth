ALTER TABLE "notification_outbox" ALTER COLUMN "priority" SET DEFAULT 'high';--> statement-breakpoint
CREATE OR REPLACE FUNCTION notification_outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hearth_outbox', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER notification_outbox_notify
AFTER INSERT ON "notification_outbox"
FOR EACH STATEMENT EXECUTE FUNCTION notification_outbox_notify();
