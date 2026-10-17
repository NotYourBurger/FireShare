-- Shares from before expiry get the default preset, 7 days, counted from when they became ready.
ALTER TABLE "shares" ADD COLUMN "expiry_seconds" integer DEFAULT 604800 NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "expiry_seconds" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "shares" SET "expires_at" = "ready_at" + interval '7 days' WHERE "status" = 'ready';
