ALTER TABLE "accounts" ADD COLUMN "expiry_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "extra_usage" boolean DEFAULT false NOT NULL;