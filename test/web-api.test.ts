import { expect, test } from "bun:test";
import { handleSnmpGet, handleSnmpWalk } from "../src/web/api.ts";
import { serializeVarBind } from "../src/web/serialization.ts";
import { SnmpError } from "@ptrsnake/ts-snmp";
import type { Snmp, SnmpOptions, VarBind } from "@ptrsnake/ts-snmp";

const v2Options: SnmpOptions = {
  version: "v2c",
  host: "192.0.2.10",
  community: "public",
};

const octetBinding: VarBind = {
  oid: "1.3.6.1.2.1.1.1.0",
  type: "OCTET_STRING",
  value: new TextEncoder().encode("agent"),
};

/** Verify byte-array and 64-bit values remain JSON-safe and preserve their syntax. */
test("web serialization encodes bytes and bigint values explicitly", () => {
  expect(serializeVarBind(octetBinding)).toEqual({
    oid: octetBinding.oid,
    type: "OCTET_STRING",
    value: "YWdlbnQ=",
    valueEncoding: "base64",
  });
  expect(serializeVarBind({ oid: "1.3.6.1.1", type: "COUNTER64", value: 9_007_199_254_740_993n })).toEqual({
    oid: "1.3.6.1.1",
    type: "COUNTER64",
    value: "9007199254740993",
    valueEncoding: "decimal",
  });
});

/** Verify Get invokes the SNMP client and always closes it after serialization. */
test("Get API returns a typed binding and closes its client", async () => {
  let closed = false;
  let receivedOptions: SnmpOptions | undefined;
  const client: Snmp = {
    get: async () => octetBinding,
    walk: async function* () {},
    close: async () => { closed = true; },
  };
  const response = await handleSnmpGet(makeRequest("/api/snmp/get", {
    options: v2Options,
    oid: octetBinding.oid,
  }), (options) => {
    receivedOptions = options;
    return client;
  });

  expect(response.status).toBe(200);
  expect(receivedOptions).toEqual(v2Options);
  expect(await response.json()).toEqual({ binding: serializeVarBind(octetBinding) });
  expect(closed).toBe(true);
});

/** Verify invalid destinations are rejected before any network client is created. */
test("API rejects non-IP targets and invalid OIDs", async () => {
  let factoryCalled = false;
  const factory = () => {
    factoryCalled = true;
    return mockClient();
  };
  const invalidHost = await handleSnmpGet(makeRequest("/api/snmp/get", {
    options: { ...v2Options, host: "example.invalid" },
    oid: octetBinding.oid,
  }), factory);
  expect(invalidHost.status).toBe(400);
  expect(factoryCalled).toBe(false);

  const invalidOid = await handleSnmpGet(makeRequest("/api/snmp/get", {
    options: v2Options,
    oid: "1.3.bad",
  }), factory);
  expect(invalidOid.status).toBe(400);
  expect(factoryCalled).toBe(false);
});

/** Verify Walk streams one JSON event per binding and closes on completion. */
test("Walk API streams NDJSON bindings followed by a done event", async () => {
  let closed = false;
  const counter: VarBind = { oid: "1.3.6.1.2.1.2.1", type: "COUNTER64", value: 12n };
  const client: Snmp = {
    get: async () => octetBinding,
    walk: async function* () {
      yield octetBinding;
      yield counter;
    },
    close: async () => { closed = true; },
  };
  const response = await handleSnmpWalk(makeRequest("/api/snmp/walk", {
    options: v2Options,
    oid: "1.3.6.1.2.1.1",
  }), () => client);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  expect(lines).toEqual([
    { event: "binding", binding: serializeVarBind(octetBinding) },
    { event: "binding", binding: serializeVarBind(counter) },
    { event: "done" },
  ]);
  expect(closed).toBe(true);
});

/** Verify cancelling a Walk response closes the UDP client immediately. */
test("cancelling a Walk stream closes its client", async () => {
  let closed = false;
  const client: Snmp = {
    get: async () => octetBinding,
    walk: async function* () {
      while (true) yield octetBinding;
    },
    close: async () => { closed = true; },
  };
  const response = await handleSnmpWalk(makeRequest("/api/snmp/walk", {
    options: v2Options,
    oid: "1.3.6.1.2.1.1",
  }), () => client);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();

  expect(closed).toBe(true);
});

/** Verify cross-origin browser requests are refused and never reach the client factory. */
test("API rejects cross-origin requests", async () => {
  let factoryCalled = false;
  const request = makeRequest("/api/snmp/get", {
    options: v2Options,
    oid: octetBinding.oid,
  }, "https://attacker.example");
  const response = await handleSnmpGet(request, () => {
    factoryCalled = true;
    return mockClient();
  });
  expect(response.status).toBe(403);
  expect(factoryCalled).toBe(false);
});

/** Verify operational errors do not serialize secret configuration. */
test("API errors do not echo SNMP credentials", async () => {
  const client: Snmp = {
    get: async () => { throw new SnmpError("Agent unavailable", "SNMP_AGENT_ERROR"); },
    walk: async function* () {},
    close: async () => {},
  };
  const secret = "not-for-response";
  const response = await handleSnmpGet(makeRequest("/api/snmp/get", {
    options: { ...v2Options, community: secret },
    oid: octetBinding.oid,
  }), () => client);
  const body = await response.text();

  expect(response.status).toBe(502);
  expect(body).not.toContain(secret);
  expect(body).toContain("Agent unavailable");
});

/** Construct the same-origin JSON request expected by the local API handlers. */
function makeRequest(path: string, body: unknown, origin?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Return a minimal inert client for validation tests. */
function mockClient(): Snmp {
  return {
    get: async () => octetBinding,
    walk: async function* () {},
    close: async () => {},
  };
}
