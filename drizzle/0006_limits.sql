ALTER TABLE "shares" ADD COLUMN "client_ip" text;--> statement-breakpoint
CREATE INDEX "shares_client_ip_created_at_index" ON "shares" USING btree ("client_ip","created_at");