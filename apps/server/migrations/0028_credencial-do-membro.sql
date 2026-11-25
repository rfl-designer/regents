CREATE TABLE "member_connector_credentials" (
	"connector_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"state" text NOT NULL,
	"refused_at" timestamp with time zone,
	"connected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "member_connector_credentials_connector_id_member_id_pk" PRIMARY KEY("connector_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "execution_tool_calls" ADD COLUMN "used" text;--> statement-breakpoint
ALTER TABLE "execution_tool_calls" ADD COLUMN "connect_connector_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_tool_calls" ADD COLUMN "connect_name" text;--> statement-breakpoint
ALTER TABLE "member_connector_credentials" ADD CONSTRAINT "member_connector_credentials_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_connector_credentials" ADD CONSTRAINT "member_connector_credentials_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;