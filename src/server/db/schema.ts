import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { UploadedPart } from "../storage/adapter";

export const shares = pgTable("shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status", { enum: ["pending", "ready"] }).notNull().default("pending"),
  /** SHA-256 of the share link token; the token itself is never stored. */
  tokenHash: text("token_hash").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
});

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  shareId: uuid("share_id")
    .notNull()
    .references(() => shares.id, { onDelete: "cascade" }),
  /** Client-supplied filename: metadata only, never a storage path. */
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  /** Server-chosen random key in the bucket. */
  storageKey: text("storage_key").notNull().unique(),
  multipartUploadId: text("multipart_upload_id").notNull(),
  /** Bytes received so far. */
  uploadOffset: bigint("upload_offset", { mode: "number" }).notNull().default(0),
  parts: jsonb("parts").$type<UploadedPart[]>().notNull().default([]),
});
