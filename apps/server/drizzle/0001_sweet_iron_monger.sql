ALTER TABLE "sends" ADD COLUMN "warmup_depth" integer;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "sends" ADD COLUMN "references_hdr" text;--> statement-breakpoint
CREATE INDEX "sends_kind_date" ON "sends" USING btree ("workspace_id","kind","local_date");