CREATE TYPE "public"."account_state" AS ENUM('not_linked', 'linked');--> statement-breakpoint
CREATE TABLE "accounts" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"state" "account_state" NOT NULL,
	"email" text,
	"claude_org_id" text,
	"subscription_type" text,
	"plan_tier" text,
	"login_expires_at" timestamp with time zone,
	"config_dir" text,
	"linked_at" timestamp with time zone,
	"offer_dismissed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;