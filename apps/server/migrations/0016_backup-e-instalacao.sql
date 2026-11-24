CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"file" text,
	"bytes" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "installation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "installation_uma_linha" CHECK ("installation"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "installation_alerts" (
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "installation_alerts_kind_ref_pk" PRIMARY KEY("kind","ref")
);
--> statement-breakpoint
CREATE INDEX "backups_finished_at_index" ON "backups" USING btree ("finished_at");