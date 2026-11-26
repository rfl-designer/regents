CREATE TABLE "wiki_restores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "wiki_restores_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wiki_id" uuid NOT NULL,
	"from_version_id" uuid NOT NULL,
	"to_version_id" uuid NOT NULL,
	"by_member_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_restores" ADD CONSTRAINT "wiki_restores_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_restores" ADD CONSTRAINT "wiki_restores_from_version_id_wiki_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_restores" ADD CONSTRAINT "wiki_restores_to_version_id_wiki_versions_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_restores" ADD CONSTRAINT "wiki_restores_by_member_id_members_id_fk" FOREIGN KEY ("by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_restores_to_version_id_seq_index" ON "wiki_restores" USING btree ("to_version_id","seq");