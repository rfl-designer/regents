CREATE TYPE "public"."memory_author" AS ENUM('extraction', 'member', 'admin');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('workspace', 'conversation', 'agent');--> statement-breakpoint
CREATE TYPE "public"."memory_state" AS ENUM('active', 'archived');--> statement-breakpoint
ALTER TYPE "public"."execution_kind" ADD VALUE 'memory';--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "memory_items_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" "memory_scope" NOT NULL,
	"conversation_id" uuid,
	"origin_message_id" uuid,
	"agent_id" uuid,
	"text" text NOT NULL,
	"created_by" "memory_author" NOT NULL,
	"created_by_member_id" uuid,
	"execution_id" uuid,
	"state" "memory_state" NOT NULL,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "memory_items_agente_so_no_escopo_agente" CHECK (("memory_items"."scope" = 'agent') = ("memory_items"."agent_id" is not null)),
	CONSTRAINT "memory_items_conversa_com_origem" CHECK ("memory_items"."scope" = 'workspace' or ("memory_items"."conversation_id" is not null and "memory_items"."origin_message_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "source_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_conversation_id_channels_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_origin_message_id_messages_id_fk" FOREIGN KEY ("origin_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_replaced_by_id_memory_items_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."memory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_conversation_id_state_seq_index" ON "memory_items" USING btree ("conversation_id","state","seq");--> statement-breakpoint
CREATE INDEX "memory_items_agent_id_state_seq_index" ON "memory_items" USING btree ("agent_id","state","seq");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_source_execution_id_executions_id_fk" FOREIGN KEY ("source_execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;