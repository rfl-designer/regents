CREATE TYPE "public"."key_incident_kind" AS ENUM('auth_failed', 'billing_failed');--> statement-breakpoint
CREATE TABLE "budget_overruns" (
	"agent_id" uuid NOT NULL,
	"month" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "budget_overruns_agent_id_month_pk" PRIMARY KEY("agent_id","month")
);
--> statement-breakpoint
CREATE TABLE "execution_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"payer" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"month" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "key_incident_kind" NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "monthly_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "budget_overruns" ADD CONSTRAINT "budget_overruns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_usage" ADD CONSTRAINT "execution_usage_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_usage" ADD CONSTRAINT "execution_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_usage_agent_id_month_index" ON "execution_usage" USING btree ("agent_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "key_incidents_one_open" ON "key_incidents" USING btree (("closed_at" is null)) WHERE "key_incidents"."closed_at" is null;