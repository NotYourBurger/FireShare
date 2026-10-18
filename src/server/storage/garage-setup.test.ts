import { describe, expect, it } from "vitest";
import { setupGarage } from "./garage-setup";

/** Just enough of Garage's admin API v2 for setupGarage, recording each call. */
function fakeGarage(token = "admin-token") {
  const state = {
    nodes: [{ id: "node1", role: null as unknown }],
    layoutVersion: 0,
    buckets: new Map<string, string>(),
    keys: [] as { id: string; name: string; secret: string }[],
    grants: [] as unknown[],
  };
  const calls: string[] = [];
  const fetch = (async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    const endpoint = url.pathname.replace("/v2/", "");
    calls.push(endpoint);
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${token}`) return new Response("", { status: 403 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown) => Response.json(value);
    switch (endpoint) {
      case "GetClusterStatus":
        return json({ layoutVersion: state.layoutVersion, nodes: state.nodes });
      case "GetClusterLayout":
        return json({ version: state.layoutVersion });
      case "UpdateClusterLayout":
        state.nodes[0].role = body.roles[0];
        return json({});
      case "ApplyClusterLayout":
        expect(body.version).toBe(state.layoutVersion + 1);
        state.layoutVersion = body.version;
        return json({});
      case "GetBucketInfo": {
        const id = state.buckets.get(url.searchParams.get("globalAlias")!);
        return id ? json({ id }) : new Response("no such bucket", { status: 404 });
      }
      case "CreateBucket":
        state.buckets.set(body.globalAlias, `bucket-${body.globalAlias}`);
        return json({ id: `bucket-${body.globalAlias}` });
      case "ListKeys":
        return json(state.keys.map(({ id, name }) => ({ id, name, expired: false })));
      case "GetKeyInfo": {
        const key = state.keys.find((k) => k.id === url.searchParams.get("id"))!;
        expect(url.searchParams.get("showSecretKey")).toBe("true");
        return json({ accessKeyId: key.id, secretAccessKey: key.secret });
      }
      case "CreateKey": {
        const key = { id: `GK${state.keys.length + 1}`, name: body.name, secret: "generated-secret" };
        state.keys.push(key);
        return json({ accessKeyId: key.id, secretAccessKey: key.secret });
      }
      case "AllowBucketKey":
        state.grants.push(body);
        return json({});
      default:
        return new Response("unknown endpoint", { status: 400 });
    }
  }) as typeof globalThis.fetch;
  return { state, calls, fetch };
}

const config = { adminUrl: "http://storage:3903", adminToken: "admin-token", bucket: "fireshare", keyName: "fireshare-app" };

describe("Garage setup", () => {
  it("gives the node a role, and creates the bucket and a key allowed into it only", async () => {
    const garage = fakeGarage();
    const credentials = await setupGarage({ ...config, fetch: garage.fetch });

    expect(credentials).toEqual({ accessKeyId: "GK1", secretAccessKey: "generated-secret" });
    expect(garage.state.layoutVersion).toBe(1);
    expect(garage.state.nodes[0].role).toMatchObject({ zone: "dc1", capacity: expect.any(Number) });
    expect(garage.state.buckets.get("fireshare")).toBe("bucket-fireshare");
    expect(garage.state.grants).toEqual([
      { bucketId: "bucket-fireshare", accessKeyId: "GK1", permissions: { read: true, write: true, owner: true } },
    ]);
  });

  it("reuses what an earlier run set up", async () => {
    const garage = fakeGarage();
    await setupGarage({ ...config, fetch: garage.fetch });
    garage.calls.length = 0;

    const credentials = await setupGarage({ ...config, fetch: garage.fetch });

    expect(credentials).toEqual({ accessKeyId: "GK1", secretAccessKey: "generated-secret" });
    expect(garage.state.keys).toHaveLength(1);
    expect(garage.calls).not.toContain("UpdateClusterLayout");
    expect(garage.calls).not.toContain("CreateBucket");
    expect(garage.calls).not.toContain("CreateKey");
  });

  it("fails with the admin API's answer when the token is wrong", async () => {
    const garage = fakeGarage();
    await expect(setupGarage({ ...config, adminToken: "wrong", fetch: garage.fetch })).rejects.toThrow(
      /^GetClusterStatus: 403/,
    );
  });
});
