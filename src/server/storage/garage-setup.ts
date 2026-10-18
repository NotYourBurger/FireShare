/**
 * One-off setup of the bundled Garage storage through its admin API (v2):
 * gives the single node a storage role, creates the private bucket, and
 * creates the app's own key, allowed into that bucket only. Every step checks
 * what's already there first, so it runs on every start.
 */

/** Nominal capacity for the node's role. Garage uses it only to spread data across nodes, not as a quota. */
const NODE_CAPACITY = 1_000_000_000_000;

export interface GarageSetupConfig {
  /** Garage's admin API, like http://storage:3903. */
  adminUrl: string;
  adminToken: string;
  bucket: string;
  keyName: string;
  fetch?: typeof globalThis.fetch;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export class GarageAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GarageAdminError";
  }
}

export async function setupGarage(config: GarageSetupConfig): Promise<S3Credentials> {
  const fetch = config.fetch ?? globalThis.fetch;

  async function call<T>(endpoint: string, init: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`/v2/${endpoint}`, config.adminUrl);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    const res = await fetch(url, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${config.adminToken}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new GarageAdminError(res.status, `${endpoint}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // Layout: a new node has no role, so it can't store anything until it gets one.
  const status = await call<{ nodes: { id: string; role: unknown }[] }>("GetClusterStatus");
  if (status.nodes.length === 0) throw new Error("Garage reports no nodes");
  if (!status.nodes.some((node) => node.role)) {
    const layout = await call<{ version: number }>("GetClusterLayout");
    await call("UpdateClusterLayout", {
      body: { roles: [{ id: status.nodes[0].id, zone: "dc1", capacity: NODE_CAPACITY, tags: [] }] },
    });
    await call("ApplyClusterLayout", { body: { version: layout.version + 1 } });
  }

  // Bucket.
  let bucketId: string;
  try {
    bucketId = (await call<{ id: string }>("GetBucketInfo", { query: { globalAlias: config.bucket } })).id;
  } catch (err) {
    if (!(err instanceof GarageAdminError && err.status === 404)) throw err;
    bucketId = (await call<{ id: string }>("CreateBucket", { body: { globalAlias: config.bucket } })).id;
  }

  // The app's key, created by Garage. It can't create buckets; owner lets it set the bucket's CORS rules.
  const keys = await call<{ id: string; name: string }[]>("ListKeys");
  const existing = keys.find((key) => key.name === config.keyName);
  const key = existing
    ? await call<{ accessKeyId: string; secretAccessKey: string | null }>("GetKeyInfo", {
        query: { id: existing.id, showSecretKey: "true" },
      })
    : await call<{ accessKeyId: string; secretAccessKey: string | null }>("CreateKey", {
        body: { name: config.keyName },
      });
  if (!key.secretAccessKey) throw new Error(`Garage returned no secret for key ${config.keyName}`);
  await call("AllowBucketKey", {
    body: { bucketId, accessKeyId: key.accessKeyId, permissions: { read: true, write: true, owner: true } },
  });

  return { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
}
