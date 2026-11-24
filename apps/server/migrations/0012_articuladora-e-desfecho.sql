CREATE TYPE "public"."outcome_decision" AS ENUM('reply', 'delegate', 'none');--> statement-breakpoint
ALTER TYPE "public"."execution_kind" ADD VALUE 'route';--> statement-breakpoint
ALTER TYPE "public"."execution_kind" ADD VALUE 'reply';--> statement-breakpoint
ALTER TYPE "public"."execution_kind" ADD VALUE 'delegated';--> statement-breakpoint
CREATE TABLE "outcomes" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"decision" "outcome_decision" NOT NULL,
	"reason" text NOT NULL,
	"delegates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outcomes_channel_id_index" ON "outcomes" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_builtin" ON "agents" USING btree ("builtin") WHERE "agents"."builtin";--> statement-breakpoint
-- A Articuladora (ADR 0004): todo Workspace vem com ela, a Sophya. A descrição e as instruções
-- dela vêm do código (`articuladora.ts`), por isso ficam vazias aqui. Se um Agente já se chama
-- Sophya, ela nasce "Sophya (Shearim)" e o Admin renomeia.
INSERT INTO "agents" ("id", "name", "photo", "description", "instructions", "model", "created_at", "builtin")
SELECT gen_random_uuid(),
	CASE WHEN EXISTS (SELECT 1 FROM "agents" WHERE lower("name") = 'sophya') THEN 'Sophya (Shearim)' ELSE 'Sophya' END,
	NULL, '', '', 'claude-sonnet-5-5', now(), true;--> statement-breakpoint
-- O identificador dela, como `claimHandle`: `sophya`, ou `sophya2`, `sophya3`... se já for de alguém.
INSERT INTO "mention_handles" ("handle", "agent_id")
SELECT (
	SELECT c.h FROM (SELECT 'sophya' AS h, 1 AS n UNION ALL SELECT 'sophya' || g, g FROM generate_series(2, 999) g) c
	WHERE NOT EXISTS (SELECT 1 FROM "mention_handles" m WHERE m."handle" = c.h)
	ORDER BY c.n LIMIT 1
), "id" FROM "agents" WHERE "builtin";--> statement-breakpoint
-- Ela está em todo Canal, público ou privado (não nas DMs).
INSERT INTO "channel_agents" ("channel_id", "agent_id", "added_at")
SELECT c."id", a."id", c."created_at" FROM "channels" c CROSS JOIN "agents" a
WHERE a."builtin" AND c."kind" IN ('public', 'private')
ON CONFLICT DO NOTHING;
