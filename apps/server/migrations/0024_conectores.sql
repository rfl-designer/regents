CREATE TABLE "connector_tools" (
	"tool" text PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"read_only" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"credential_mode" text NOT NULL,
	"token_ciphertext" text,
	"token_iv" text,
	"credential_state" text NOT NULL,
	"refused_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connectors_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "connector_tools" ADD CONSTRAINT "connector_tools_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_tools_connector_id_position_index" ON "connector_tools" USING btree ("connector_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_name_lower" ON "connectors" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;