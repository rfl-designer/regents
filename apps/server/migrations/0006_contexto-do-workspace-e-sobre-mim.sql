ALTER TABLE "members" ADD COLUMN "about_me" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "context" text DEFAULT '' NOT NULL;