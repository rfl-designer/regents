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
	"member_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "message_mentions_message_id_member_id_pk" PRIMARY KEY("message_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "profile_pic_url" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "about" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "mention_handles" ADD CONSTRAINT "mention_handles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_member_id_index" ON "message_mentions" USING btree ("member_id");--> statement-breakpoint
-- Membros de antes do identificador ganham um provisório e único (editável no perfil).
INSERT INTO "mention_handles" ("handle", "member_id") SELECT 'membro_' || substr(replace("id"::text, '-', ''), 1, 12), "id" FROM "members";
