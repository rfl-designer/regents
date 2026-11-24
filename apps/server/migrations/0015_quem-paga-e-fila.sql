ALTER TYPE "public"."account_state" ADD VALUE 'needs_relink';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "author_reason" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "held_until" timestamp with time zone;