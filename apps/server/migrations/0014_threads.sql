CREATE TABLE "thread_follows" (
	"member_id" uuid NOT NULL,
	"root_message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"since" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_follows_member_id_root_message_id_pk" PRIMARY KEY("member_id","root_message_id")
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "thread_root_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_root_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_root_message_id_messages_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_conversation_id_channels_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_follows_root_message_id_index" ON "thread_follows" USING btree ("root_message_id");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_thread_root_id_messages_id_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_root_id_messages_id_fk" FOREIGN KEY ("thread_root_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_thread_root_id_seq_index" ON "messages" USING btree ("thread_root_id","seq");