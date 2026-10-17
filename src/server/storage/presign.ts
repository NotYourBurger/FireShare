import { createHash, createHmac } from "node:crypto";
import { PRESIGN_TTL_SECONDS, type PresignedUrlRequest } from "./adapter";

export interface PresignConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Signs a path-style S3 URL (AWS Signature Version 4, query-string authentication
 * with `UNSIGNED-PAYLOAD`) scoped to one bucket, one key, one HTTP method and
 * the exact query parameters of `request`.
 */
export function presignS3Url(config: PresignConfig, request: PresignedUrlRequest, now: Date = new Date()): string {
  const { method, query } = requestParams(request);
  const expiresInSeconds = request.expiresInSeconds ?? PRESIGN_TTL_SECONDS;
  const base = new URL(config.endpoint);
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const basePath = base.pathname.replace(/\/$/, "");
  const encodedKey = request.key.split("/").map(encodeRfc3986).join("/");
  const canonicalUri = `${basePath}/${encodeRfc3986(config.bucket)}/${encodedKey}`;

  const params: Record<string, string> = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(params)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${base.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `${base.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function requestParams(request: PresignedUrlRequest): { method: "PUT" | "GET"; query: Record<string, string> } {
  if (request.action === "uploadPart") {
    return {
      method: "PUT",
      query: {
        partNumber: String(request.partNumber),
        uploadId: request.uploadId,
      },
    };
  }
  const query: Record<string, string> = {};
  if (request.responseContentDisposition) query["response-content-disposition"] = request.responseContentDisposition;
  if (request.responseContentType) query["response-content-type"] = request.responseContentType;
  return { method: "GET", query };
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
