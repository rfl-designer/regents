CREATE TYPE "public"."wiki_sync_state" AS ENUM('queued', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "wiki_page_sources" (
	"page_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "wiki_page_sources_page_id_source_id_pk" PRIMARY KEY("page_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "wiki_syncs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wiki_id" uuid NOT NULL,
	"started_by_member_id" uuid NOT NULL,
	"state" "wiki_sync_state" DEFAULT 'queued' NOT NULL,
	"step" jsonb,
	"reason" text,
	"report" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_version_sources" (
	"version_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "wiki_version_sources_version_id_source_id_pk" PRIMARY KEY("version_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "wiki_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wiki_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"sync_id" uuid NOT NULL,
	"report" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_usage" ALTER COLUMN "execution_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_usage" ADD COLUMN "wiki_sync_id" uuid;--> statement-breakpoint
ALTER TABLE "wikis" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "wiki_page_sources" ADD CONSTRAINT "wiki_page_sources_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_sources" ADD CONSTRAINT "wiki_page_sources_source_id_wiki_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."wiki_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_version_id_wiki_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_syncs" ADD CONSTRAINT "wiki_syncs_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_syncs" ADD CONSTRAINT "wiki_syncs_started_by_member_id_members_id_fk" FOREIGN KEY ("started_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_version_sources" ADD CONSTRAINT "wiki_version_sources_version_id_wiki_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_version_sources" ADD CONSTRAINT "wiki_version_sources_source_id_wiki_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."wiki_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_versions" ADD CONSTRAINT "wiki_versions_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_versions" ADD CONSTRAINT "wiki_versions_sync_id_wiki_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."wiki_syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_version_id_slug_index" ON "wiki_pages" USING btree ("version_id","slug");--> statement-breakpoint
CREATE INDEX "wiki_syncs_wiki_id_seq_index" ON "wiki_syncs" USING btree ("wiki_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_syncs_one_open_per_wiki" ON "wiki_syncs" USING btree ("wiki_id") WHERE "wiki_syncs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "wiki_version_sources_source_id_index" ON "wiki_version_sources" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_versions_wiki_id_number_index" ON "wiki_versions" USING btree ("wiki_id","number");--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_current_version_id_wiki_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."wiki_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_usage" ADD CONSTRAINT "execution_usage_one_origin" CHECK (num_nonnulls("execution_usage"."execution_id", "execution_usage"."wiki_sync_id") = 1);