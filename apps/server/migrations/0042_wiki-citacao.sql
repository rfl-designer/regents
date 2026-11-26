CREATE TABLE "message_wiki_citations" (
	"message_id" uuid NOT NULL,
	"marker" text NOT NULL,
	"wiki_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "message_wiki_citations_message_id_marker_pk" PRIMARY KEY("message_id","marker")
);
--> statement-breakpoint
CREATE TABLE "wiki_reads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "wiki_reads_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"execution_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"wiki_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"slug" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ADD CONSTRAINT "message_wiki_citations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ADD CONSTRAINT "message_wiki_citations_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_wiki_citations" ADD CONSTRAINT "message_wiki_citations_version_id_wiki_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_reads" ADD CONSTRAINT "wiki_reads_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_reads" ADD CONSTRAINT "wiki_reads_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_reads" ADD CONSTRAINT "wiki_reads_version_id_wiki_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_reads_execution_id_attempt_index" ON "wiki_reads" USING btree ("execution_id","attempt");