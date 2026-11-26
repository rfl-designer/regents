CREATE TABLE "wiki_members" (
	"wiki_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wiki_members_wiki_id_member_id_pk" PRIMARY KEY("wiki_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "wiki_members" ADD CONSTRAINT "wiki_members_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_members" ADD CONSTRAINT "wiki_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_members_member_id_index" ON "wiki_members" USING btree ("member_id");