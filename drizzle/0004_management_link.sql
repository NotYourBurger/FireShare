ALTER TABLE "shares" ADD COLUMN "management_token_hash" text;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_management_token_hash_unique" UNIQUE("management_token_hash");