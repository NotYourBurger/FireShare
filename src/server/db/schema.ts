import { bigint, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { UploadedPart } from "../storage/adapter";

/** One received chunk: the storage part it became, plus its integrity data. */
export interface FilePart extends UploadedPart {
  size: number;
  /** Hex SHA-256 sent by the browser and checked before the part was written. */
  sha256: string;
  /** Computed as the chunk streamed through; combined, they give the file's CRC32. */
  crc32: number;
}

export const shares = pgTable("shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Expiry isn't a status: a `ready` share is expired once `expiresAt` has
   * passed. `abandoned` is a `pending` share past `PENDING_TTL` that the
   * cleanup worker has claimed; its row goes once its storage is gone.
   */
  status: text("status", { enum: ["pending", "ready", "deleted", "abandoned"] }).notNull().default("pending"),
  /** SHA-256 of the share link token; the token itself is never stored. */
  tokenHash: text("token_hash").unique(),
  /** SHA-256 of the management link token, issued with the share link. Null for shares from before management links. */
  managementTokenHash: text("management_token_hash").unique(),
  /** Sender-supplied plain text, shown to recipients. */
  title: text("title"),
  message: text("message"),
  /** How long the link works once the share is ready, from the uploader's chosen preset. */
  expirySeconds: integer("expiry_seconds").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  /** Set with `readyAt`; from then on the link serves nothing. Never extended. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** When the uploader deleted the share early through its management link. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareId: uuid("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    /** Order in which the uploader listed the file. */
    position: integer("position").notNull(),
    /** Client-supplied filename: metadata only, never a storage path. */
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Server-chosen random key in the bucket. */
    storageKey: text("storage_key").notNull().unique(),
    multipartUploadId: text("multipart_upload_id").notNull(),
    /** Bytes received so far. */
    uploadOffset: bigint("upload_offset", { mode: "number" }).notNull().default(0),
    /** In order; each chunk is one part. */
    parts: jsonb("parts").$type<FilePart[]>().notNull().default([]),
    /** When storage assembled the object; set during finalize. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * The file's fingerprint, recorded at finalize: the SHA-256 of its chunk
     * hashes (hex) and the ETag storage gave the assembled object. Null for
     * files completed before fingerprints were recorded.
     */
    fingerprintHash: text("fingerprint_hash"),
    fingerprintEtag: text("fingerprint_etag"),
    /** When the cleanup worker deleted the stored object, after the share expired or was deleted. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [unique().on(table.shareId, table.position)],
);
