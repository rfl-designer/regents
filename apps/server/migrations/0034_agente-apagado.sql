DROP INDEX "agents_name_lower_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_name_lower_unique" ON "agents" USING btree (lower("name")) WHERE "agents"."deleted_at" is null;