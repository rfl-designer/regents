CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'refused');--> statement-breakpoint
CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tailnet_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"profile_pic_url" text,
	"device" text,
	"sharee" boolean NOT NULL,
	"status" "join_request_status" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_member_id" uuid
);
--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_one_pending" ON "join_requests" USING btree ("tailnet_user_id") WHERE "join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "join_requests_tailnet_user_id_created_at_index" ON "join_requests" USING btree ("tailnet_user_id","created_at");