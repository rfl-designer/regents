CREATE TABLE "github_app" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pending_state" text,
	"origin" text,
	"app_id" bigint,
	"slug" text,
	"name" text,
	"owner" text,
	"html_url" text,
	"secrets_ciphertext" text,
	"secrets_iv" text,
	"created_at" timestamp with time zone,
	"installation_id" bigint,
	"installation_account" text,
	"installed_at" timestamp with time zone,
	"failure_reason" text,
	"failed_at" timestamp with time zone,
	CONSTRAINT "github_app_uma_linha" CHECK ("github_app"."id" = 1)
);
