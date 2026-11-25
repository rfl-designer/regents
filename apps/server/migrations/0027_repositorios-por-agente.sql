CREATE TABLE "agent_github_repositories" (
	"agent_id" uuid NOT NULL,
	"repository" text NOT NULL,
	CONSTRAINT "agent_github_repositories_agent_id_repository_pk" PRIMARY KEY("agent_id","repository")
);
--> statement-breakpoint
ALTER TABLE "agent_github_repositories" ADD CONSTRAINT "agent_github_repositories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;