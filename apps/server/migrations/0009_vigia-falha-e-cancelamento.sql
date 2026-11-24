ALTER TYPE "public"."execution_state" ADD VALUE 'retrying' BEFORE 'done';--> statement-breakpoint
ALTER TYPE "public"."execution_state" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "api_retry_attempt" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "api_retry_max" integer;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "retried_by_author" boolean DEFAULT false NOT NULL;