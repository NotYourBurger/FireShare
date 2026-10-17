import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Carries the socket's remote address to the request handlers, which only see
 * a web `Request`. Set on every request by `installPeerAddressHeader`,
 * replacing anything the client sent under the same name.
 */
export const PEER_ADDRESS_HEADER = "x-fireshare-peer-address";

/** A set of networks, e.g. `UPLOAD_ALLOWED_IPS` or `TRUSTED_PROXIES`. */
export interface Networks {
  has(address: string): boolean;
}

const INSTALLED = Symbol.for("fireshare.peerAddressHeader");

/**
 * Next.js doesn't pass the socket's address on, and its own `X-Forwarded-For`
 * keeps whatever the client sent, so copy the address into a header before
 * Next.js sees the request. Safe to call more than once.
 */
export function installPeerAddressHeader() {
  for (const Server of [http.Server, https.Server]) {
    const proto = Server.prototype as {
      emit(event: string | symbol, ...args: unknown[]): boolean;
      [INSTALLED]?: true;
    };
    if (proto[INSTALLED]) continue;
    const emit = proto.emit;
    proto.emit = function (event, ...args) {
      if (event === "request") {
        const req = args[0] as http.IncomingMessage;
        const address = req.socket.remoteAddress;
        if (address) req.headers[PEER_ADDRESS_HEADER] = address;
        else delete req.headers[PEER_ADDRESS_HEADER];
      }
      return emit.call(this, event, ...args);
    };
    proto[INSTALLED] = true;
  }
}

/**
 * The client's IP address: the socket's, or, when the socket is a trusted
 * proxy, the nearest `X-Forwarded-For` hop that isn't one. Null when the
 * socket address is unknown.
 */
export function clientAddress(headers: Pick<Headers, "get">, trustedProxies: Networks | null): string | null {
  const peer = normalizeAddress(headers.get(PEER_ADDRESS_HEADER) ?? "");
  if (!peer) return null;
  if (!trustedProxies?.has(peer)) return peer;

  // Each proxy appends the address it was connected from, so read from the
  // right and stop at the first hop no trusted proxy vouches for.
  let client = peer;
  const hops = (headers.get("X-Forwarded-For") ?? "").split(",").reverse();
  for (const hop of hops) {
    const address = normalizeAddress(hop);
    if (!address) break;
    client = address;
    if (!trustedProxies.has(address)) break;
  }
  return client;
}

/**
 * The networks in a comma-separated list of CIDR ranges or single addresses,
 * IPv4 or IPv6; null when the list is empty. Throws on any invalid entry.
 */
export function parseNetworks(list: string | undefined, name: string): Networks | null {
  if (!list?.trim()) return null;
  const blocks = new BlockList();
  for (const entry of list.split(",")) {
    const value = entry.trim();
    const [raw, bits, extra] = value.split("/");
    const mapped = bits === undefined && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
    const address = mapped ? mapped[1] : raw;
    const version = isIP(address);
    const max = version === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!version || extra !== undefined || !(prefix <= max)) {
      throw new Error(
        `Invalid ${name} entry "${value}": use IP addresses or CIDR ranges, like 192.168.1.0/24 or fd00::/8`,
      );
    }
    blocks.addSubnet(address, prefix, version === 6 ? "ipv6" : "ipv4");
  }
  return {
    has(address) {
      const normalized = normalizeAddress(address);
      return !!normalized && blocks.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4");
    },
  };
}

/**
 * A bare IP address, or null if `value` isn't one. IPv4-mapped IPv6 addresses
 * (how dual-stack sockets report IPv4 clients) become plain IPv4, and a port
 * some proxies add is dropped.
 */
export function normalizeAddress(value: string): string | null {
  let address = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) address = mapped[1];
  const version = isIP(address);
  if (version === 0) return null;
  return version === 6 ? address.toLowerCase() : address;
}
