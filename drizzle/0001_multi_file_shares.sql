-- Rows from before multi-file shares hold one file each, at position 0.
ALTER TABLE "files" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "position" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "files" SET "completed_at" = "shares"."ready_at" FROM "shares" WHERE "files"."share_id" = "shares"."id" AND "shares"."status" = 'ready';--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_share_id_position_unique" UNIQUE("share_id","position");
