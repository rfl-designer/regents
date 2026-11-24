CREATE TABLE "mention_handles" (
	"handle" text PRIMARY KEY NOT NULL,
	"member_id" uuid,
	"agent_id" uuid,
	CONSTRAINT "mention_handles_memberId_unique" UNIQUE("member_id"),
	CONSTRAINT "mention_handles_agentId_unique" UNIQUE("agent_id"),
	CONSTRAINT "mention_handles_one_owner" CHECK (num_nonnulls("mention_handles"."member_id", "mention_handles"."agent_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "profile_pic_url" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "about" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mention_handles" ADD CONSTRAINT "mention_handles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Membros de antes do identificador ganham um provisório e único (editável no perfil).
INSERT INTO "mention_handles" ("handle", "member_id") SELECT 'membro_' || substr(replace("id"::text, '-', ''), 1, 12), "id" FROM "members";
