CREATE TYPE "public"."wiki_scope" AS ENUM('public', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."wiki_source_format" AS ENUM('txt', 'md');--> statement-breakpoint
CREATE TYPE "public"."wiki_source_state" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "wiki_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "wiki_sources_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wiki_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"format" "wiki_source_format" NOT NULL,
	"text" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_member_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"state" "wiki_source_state" DEFAULT 'active' NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wikis" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"scope" "wiki_scope" DEFAULT 'public' NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_sources" ADD CONSTRAINT "wiki_sources_uploaded_by_member_id_members_id_fk" FOREIGN KEY ("uploaded_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_sources_wiki_id_seq_index" ON "wiki_sources" USING btree ("wiki_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_sources_active_file_name_unique" ON "wiki_sources" USING btree ("wiki_id",lower("file_name")) WHERE "wiki_sources"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_name_lower_unique" ON "wikis" USING btree (lower("name"));