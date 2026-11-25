CREATE TABLE "connector_logins" (
	"state" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"connector_id" uuid,
	"name" text,
	"url" text NOT NULL,
	"credential_mode" text,
	"redirect_uri" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "oauth_ciphertext" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "oauth_iv" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_connector_credentials" ADD COLUMN "oauth_ciphertext" text;--> statement-breakpoint
ALTER TABLE "member_connector_credentials" ADD COLUMN "oauth_iv" text;--> statement-breakpoint
ALTER TABLE "member_connector_credentials" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_logins" ADD CONSTRAINT "connector_logins_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_logins" ADD CONSTRAINT "connector_logins_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;