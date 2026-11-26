ALTER TABLE "message_wiki_citations" DROP CONSTRAINT "message_wiki_citations_wiki_id_wikis_id_fk";
--> statement-breakpoint
ALTER TABLE "message_wiki_citations" DROP CONSTRAINT "message_wiki_citations_version_id_wiki_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ALTER COLUMN "wiki_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ALTER COLUMN "version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ADD CONSTRAINT "message_wiki_citations_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ADD CONSTRAINT "message_wiki_citations_version_id_wiki_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE set null ON UPDATE no action;