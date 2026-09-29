import index from "./frontend/index.html";
import { handleSnmpGet, handleSnmpWalk } from "./src/web/api.ts";

/** Parse the optional environment port and keep the local server's bind address fixed. */
const port = readPort(Bun.env.PORT);

/** Run the local-only Bun server, SPA document, and same-origin SNMP API. */
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": index,
    "/api/health": {
      GET: () => Response.json({ status: "ok" }, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      }),
    },
    "/api/snmp/get": { POST: (request) => handleSnmpGet(request) },
    "/api/snmp/walk": { POST: (request) => handleSnmpWalk(request) },
  },
  development: {
    hmr: true,
    console: true,
  },
});

// Log only the local URL; request payloads and SNMP credentials are never logged.
console.info(`SNMP Console listening at http://127.0.0.1:${server.port}`);

/** Convert and validate the optional server port setting. */
function readPort(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
  }
  return parsed;
}
