CREATE TABLE "mention_handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"member_id" uuid,
	"agent_id" uuid,
	CONSTRAINT "mention_handles_memberId_unique" UNIQUE("member_id"),
	CONSTRAINT "mention_handles_agentId_unique" UNIQUE("agent_id"),
	CONSTRAINT "mention_handles_one_owner" CHECK (num_nonnulls("mention_handles"."member_id", "mention_handles"."agent_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"member_id" uuid,
	"agent_id" uuid,
	CONSTRAINT "message_mentions_message_id_ordinal_pk" PRIMARY KEY("message_id","ordinal"),
	CONSTRAINT "message_mentions_messageId_memberId_unique" UNIQUE("message_id","member_id"),
	CONSTRAINT "message_mentions_messageId_agentId_unique" UNIQUE("message_id","agent_id"),
	CONSTRAINT "message_mentions_one_owner" CHECK (num_nonnulls("message_mentions"."member_id", "message_mentions"."agent_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "profile_pic_url" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "about" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mention_handles" ADD CONSTRAINT "mention_handles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_handles" ADD CONSTRAINT "mention_handles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_member_id_index" ON "message_mentions" USING btree ("member_id");--> statement-breakpoint
-- Membros de antes do identificador ganham um provisório e único (editável no perfil).
INSERT INTO "mention_handles" ("handle", "member_id") SELECT 'membro_' || substr(replace("id"::text, '-', ''), 1, 12), "id" FROM "members";--> statement-breakpoint
-- Agentes de antes ganham o do nome, como `agentHandleBase` (nome inteiro sem espaço, sem acento,
-- minúsculo, só [a-z0-9_], até 28), com sufixo 2, 3… quando dois dão no mesmo, para a Menção pelo
-- nome seguir valendo.
INSERT INTO "mention_handles" ("handle", "agent_id")
SELECT CASE WHEN "n" = 1 THEN "base" ELSE "base" || "n" END, "id"
FROM (
	SELECT "id", "base", row_number() OVER (PARTITION BY "base" ORDER BY "created_at", "id") AS "n"
	FROM (
		SELECT "id", "created_at", coalesce(nullif(left(regexp_replace(lower(translate("name",
			'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñÝý',
			'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuuccnnyy')), '[^a-z0-9_]', '', 'g'), 28), ''), 'agente') AS "base"
		FROM "agents"
	) AS "bases"
) AS "numbered"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Quem ainda ficou sem (colisão rara com um identificador já tomado) ganha um provisório.
INSERT INTO "mention_handles" ("handle", "agent_id") SELECT 'agente_' || substr(replace("id"::text, '-', ''), 1, 12), "id" FROM "agents" WHERE "id" NOT IN (SELECT "agent_id" FROM "mention_handles" WHERE "agent_id" IS NOT NULL);
