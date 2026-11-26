CREATE TABLE "wiki_agents" (
	"wiki_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wiki_agents_wiki_id_agent_id_pk" PRIMARY KEY("wiki_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "wiki_agents" ADD CONSTRAINT "wiki_agents_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_agents" ADD CONSTRAINT "wiki_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wiki_agents_agent_id_index" ON "wiki_agents" USING btree ("agent_id");