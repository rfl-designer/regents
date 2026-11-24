ALTER TYPE "public"."channel_kind" ADD VALUE 'dm';--> statement-breakpoint
ALTER TYPE "public"."channel_kind" ADD VALUE 'group';--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_name_only_in_channels" CHECK (("channels"."kind" in ('public', 'private')) = ("channels"."name" is not null));