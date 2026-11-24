CREATE TABLE "devices" (
	"member_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_push_at" timestamp with time zone,
	"push_stopped_at" timestamp with time zone,
	CONSTRAINT "devices_member_id_id_pk" PRIMARY KEY("member_id","id")
);
--> statement-breakpoint
CREATE TABLE "push_streaks" (
	"member_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "push_streaks_member_id_conversation_id_pk" PRIMARY KEY("member_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscriptions_memberId_deviceId_unique" UNIQUE("member_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "vapid_keys" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "vapid_keys_uma_linha" CHECK ("vapid_keys"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_streaks" ADD CONSTRAINT "push_streaks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_streaks" ADD CONSTRAINT "push_streaks_conversation_id_channels_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_member_id_device_id_devices_member_id_id_fk" FOREIGN KEY ("member_id","device_id") REFERENCES "public"."devices"("member_id","id") ON DELETE no action ON UPDATE no action;