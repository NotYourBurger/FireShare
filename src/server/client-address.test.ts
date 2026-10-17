import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  clientAddress,
  installPeerAddressHeader,
  normalizeAddress,
  parseNetworks,
  PEER_ADDRESS_HEADER,
} from "./client-address";

const headers = (values: Record<string, string>) => new Headers(values);

describe("normalizeAddress", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    [" 192.0.2.1 ", "192.0.2.1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::FFFF:192.0.2.1", "192.0.2.1"],
    ["192.0.2.1:8080", "192.0.2.1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["[2001:db8::1]:443", "2001:db8::1"],
  ])("reads %s as %s", (value, expected) => {
    expect(normalizeAddress(value)).toBe(expected);
  });

  it.each(["", "unknown", "192.0.2", "999.0.0.1", "example.com", "_hidden"])("rejects %s", (value) => {
    expect(normalizeAddress(value)).toBeNull();
  });
});

describe("parseNetworks", () => {
  it("is null for an empty list", () => {
    expect(parseNetworks(undefined, "X")).toBeNull();
    expect(parseNetworks(" ", "X")).toBeNull();
  });

  it("matches CIDR ranges and single addresses, IPv4 and IPv6", () => {
    const networks = parseNetworks("10.0.0.0/8, 192.168.1.5/24,203.0.113.9, fd00::/8, 2001:db8::1", "X")!;
    for (const address of ["10.200.3.4", "192.168.1.200", "203.0.113.9", "::ffff:10.0.0.1", "fd12:3456::1", "2001:db8::1"]) {
      expect(networks.has(address), address).toBe(true);
    }
    for (const address of ["11.0.0.1", "192.168.2.1", "203.0.113.10", "fe80::1", "2001:db8::2", "nonsense"]) {
      expect(networks.has(address), address).toBe(false);
    }
  });

  it("accepts an IPv4-mapped address", () => {
    expect(parseNetworks("::ffff:192.0.2.1", "X")!.has("192.0.2.1")).toBe(true);
  });

  it.each(["10.0.0.0/33", "fd00::/129", "10.0.0.0/", "10.0.0.0/8/8", "10.0.0", "example.com", "10.0.0.0/8,,", "10.0.0.0/-1"])(
    "rejects %s",
    (value) => {
      expect(() => parseNetworks(value, "TRUSTED_PROXIES")).toThrow(/^Invalid TRUSTED_PROXIES entry/);
    },
  );
});

describe("clientAddress", () => {
  const proxies = parseNetworks("10.0.0.0/24", "TRUSTED_PROXIES");

  it("is the socket address without trusted proxies", () => {
    expect(clientAddress(headers({ [PEER_ADDRESS_HEADER]: "::ffff:192.0.2.1" }), null)).toBe("192.0.2.1");
  });

  it("ignores X-Forwarded-For from an address that isn't a trusted proxy", () => {
    const forged = headers({ [PEER_ADDRESS_HEADER]: "198.51.100.7", "X-Forwarded-For": "10.0.0.5, 192.0.2.1" });
    expect(clientAddress(forged, proxies)).toBe("198.51.100.7");
    expect(clientAddress(forged, null)).toBe("198.51.100.7");
  });

  it("takes the nearest hop no trusted proxy vouches for", () => {
    // The client sent a forged first entry; two trusted proxies appended theirs.
    const chained = headers({
      [PEER_ADDRESS_HEADER]: "10.0.0.2",
      "X-Forwarded-For": "1.2.3.4, 192.0.2.1, 10.0.0.3",
    });
    expect(clientAddress(chained, proxies)).toBe("192.0.2.1");
  });

  it("stops at a malformed hop, keeping the last address a trusted proxy gave", () => {
    const malformed = headers({ [PEER_ADDRESS_HEADER]: "10.0.0.2", "X-Forwarded-For": "192.0.2.1, unknown, 10.0.0.3" });
    expect(clientAddress(malformed, proxies)).toBe("10.0.0.3");
  });

  it("is the proxy itself when it forwards nothing", () => {
    expect(clientAddress(headers({ [PEER_ADDRESS_HEADER]: "10.0.0.2" }), proxies)).toBe("10.0.0.2");
  });

  it("is null without a socket address", () => {
    expect(clientAddress(headers({ "X-Forwarded-For": "192.0.2.1" }), proxies)).toBeNull();
  });
});

describe("installPeerAddressHeader", () => {
  it("replaces a client-sent peer address header with the socket's address", async () => {
    installPeerAddressHeader();
    installPeerAddressHeader();
    const seen: (string | string[] | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers[PEER_ADDRESS_HEADER]);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_ADDRESS_HEADER]: "192.168.1.20" } });
      await fetch(`http://127.0.0.1:${port}/`);
    } finally {
      server.close();
    }
    expect(seen).toEqual(["127.0.0.1", "127.0.0.1"]);
  });
});
