CREATE TABLE "wiki_channels" (
	"wiki_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wiki_channels_wiki_id_channel_id_pk" PRIMARY KEY("wiki_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "wiki_channels" ADD CONSTRAINT "wiki_channels_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_channels" ADD CONSTRAINT "wiki_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_channels_channel_id_index" ON "wiki_channels" USING btree ("channel_id");