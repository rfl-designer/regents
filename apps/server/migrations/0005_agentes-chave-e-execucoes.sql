CREATE TYPE "public"."execution_kind" AS ENUM('mention');--> statement-breakpoint
CREATE TYPE "public"."execution_state" AS ENUM('queued', 'running', 'done', 'failed', 'not_acting');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"photo" text,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_agents" (
	"channel_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_agents_channel_id_agent_id_pk" PRIMARY KEY("channel_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "executions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "execution_kind" NOT NULL,
	"channel_id" uuid NOT NULL,
	"origin_message_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"state" "execution_state" NOT NULL,
	"step" text,
	"since" timestamp with time zone NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"payer" text,
	"reason" text,
	"arrived_at" timestamp with time zone NOT NULL,
	"reply_message_id" uuid,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"key_ciphertext" text,
	"key_iv" text,
	"key_updated_at" timestamp with time zone,
	CONSTRAINT "workspace_settings_uma_linha" CHECK ("workspace_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "author_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "origin_message_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_origin_message_id_messages_id_fk" FOREIGN KEY ("origin_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_reply_message_id_messages_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_lower_unique" ON "agents" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "executions_state_arrived_at_seq_index" ON "executions" USING btree ("state","arrived_at","seq");--> statement-breakpoint
CREATE INDEX "executions_channel_id_state_index" ON "executions" USING btree ("channel_id","state");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_origin_message_id_messages_id_fk" FOREIGN KEY ("origin_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_um_autor" CHECK (num_nonnulls("messages"."author_member_id", "messages"."author_agent_id") = 1);