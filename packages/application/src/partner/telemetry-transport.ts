import { Resolver, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

/** Collector DNS must not queue libc lookups on the DB's shared libuv pool.
 * Each export owns cancellable c-ares queries and a deadline including DNS,
 * connection, TLS and response body. TLS still verifies the original hostname.
 */
export function postPartnerTelemetry(url: URL, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolver = new Resolver({ timeout: 1000, tries: 1 });
    let settled = false;
    const lookup: LookupFunction = (hostname, options, callback) => {
      const query = (family: 4 | 6) => new Promise<LookupAddress[]>((yes, no) => {
        const done = (error: NodeJS.ErrnoException | null, addresses: string[]) => {
          if (error || !addresses?.length) no(error ?? new Error("Collector DNS has no addresses"));
          else yes(addresses.map(address => ({ address, family })));
        };
        if (family === 4) resolver.resolve4(hostname, done);
        else resolver.resolve6(hostname, done);
      });
      const families: Array<4 | 6> = options.family === 4 ? [4] : options.family === 6 ? [6] : [4, 6];
      void Promise.allSettled(families.map(query)).then(results => {
        if (settled) return;
        const addresses = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
        if (!addresses.length) {
          callback(Object.assign(new Error("Collector DNS unavailable"), { code: "ENOTFOUND" }), []);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST", agent: false, lookup,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    const finish = (error?: Error, result = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolver.cancel();
      request.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const deadline = setTimeout(() => finish(new Error("Telemetry collector timeout")), 2000);
    request.on("error", () => finish(new Error("Telemetry collector unavailable")));
    request.on("response", response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        finish(new Error("Telemetry collector unavailable"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) {
          response.destroy();
          finish(new Error("Telemetry response exceeds byte limit"));
        } else chunks.push(chunk);
      });
      response.on("error", () => finish(new Error("Telemetry response interrupted")));
      response.on("end", () => finish(undefined, Buffer.concat(chunks, bytes).toString("utf8")));
    });
    request.end(body);
  });
}
