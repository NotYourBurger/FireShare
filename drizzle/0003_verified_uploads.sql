ALTER TABLE "files" ADD COLUMN "fingerprint_hash" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "fingerprint_etag" text;--> statement-breakpoint
-- Chunks received before this change carry no SHA-256 or CRC32. Unfinished
-- uploads start over from the first chunk (its part overwrites the old one);
-- files already assembled are left as they are, without a fingerprint.
UPDATE "files" SET "upload_offset" = 0, "parts" = '[]'::jsonb
WHERE "completed_at" IS NULL AND "share_id" IN (SELECT "id" FROM "shares" WHERE "status" = 'pending');
