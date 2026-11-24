CREATE TABLE "agent_tools" (
	"agent_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_tools_agent_id_tool_pk" PRIMARY KEY("agent_id","tool")
);
--> statement-breakpoint
CREATE TABLE "execution_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "execution_tool_calls_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"execution_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"tool" text NOT NULL,
	"title" text NOT NULL,
	"label" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_tool_calls" ADD CONSTRAINT "execution_tool_calls_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_tool_calls_execution_id_attempt_index" ON "execution_tool_calls" USING btree ("execution_id","attempt");