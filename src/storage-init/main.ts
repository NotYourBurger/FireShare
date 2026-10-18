import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setupGarage } from "../server/storage/garage-setup";

// Runs on every start of the bundled storage, then exits: sets up Garage and
// hands the app's key to the app and the worker through a shared volume,
// read as S3_ACCESS_KEY_ID_FILE and S3_SECRET_ACCESS_KEY_FILE.
const adminToken = process.env.GARAGE_ADMIN_TOKEN?.trim();
const bucket = process.env.S3_BUCKET?.trim() || "fireshare";
const adminUrl = process.env.GARAGE_ADMIN_URL?.trim() || "http://storage:3903";
const credentialsDir = process.env.CREDENTIALS_DIR?.trim() || "/credentials";
if (!adminToken) {
  console.error("Set GARAGE_ADMIN_TOKEN in .env");
  process.exit(1);
}

/** Writes `contents` so readers never see a half-written file. */
async function writeAtomically(file: string, contents: string) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}

const TRIES = 60;

async function main(token: string) {
  for (let i = 1; ; i++) {
    try {
      const credentials = await setupGarage({ adminUrl, adminToken: token, bucket, keyName: "fireshare-app" });
      await mkdir(credentialsDir, { recursive: true });
      await writeAtomically(path.join(credentialsDir, "s3-access-key-id"), credentials.accessKeyId);
      await writeAtomically(path.join(credentialsDir, "s3-secret-access-key"), credentials.secretAccessKey);
      console.log(`Storage ready: bucket ${bucket} is private, and key ${credentials.accessKeyId} can access only it`);
      return;
    } catch (err) {
      if (i >= TRIES) {
        console.error(`Storage setup failed after ${TRIES} tries:`, err instanceof Error ? err.message : err);
        process.exit(1);
      }
      console.warn(`Waiting for storage (${i}/${TRIES}):`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

void main(adminToken);
