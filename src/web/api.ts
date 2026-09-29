import { isIP } from "node:net";
import { SnmpClient, SnmpError } from "@ptrsnake/ts-snmp";
import type { Snmp, SnmpOptions, VarBind } from "@ptrsnake/ts-snmp";
import { encodeNdjsonLine, serializeVarBind, type WalkStreamEvent } from "./serialization.ts";

/** Maximum accepted JSON request body size. */
const MAX_REQUEST_BYTES = 16_384;
/** Maximum allowed operation timeout accepted from the web UI. */
const MAX_TIMEOUT_MS = 60_000;
/** Maximum allowed retries accepted from the web UI. */
const MAX_RETRIES = 5;

/** Factory seam that allows API tests to use mock SNMP clients. */
export type SnmpClientFactory = (options: SnmpOptions) => Snmp;

/** Request payload shared by the Get and Walk endpoints. */
interface SnmpOperationRequest {
  /** Version-specific SNMP client configuration. */
  options: SnmpOptions;
  /** Requested scalar OID or root OID for Walk. */
  oid: string;
}

/** Validation error returned to the browser as an HTTP 4xx response. */
class ApiValidationError extends Error {
  /** Stable API validation code. */
  readonly code: string;
  /** Appropriate client-facing HTTP status. */
  readonly status: number;

  /** Create a request validation error. */
  constructor(message: string, code = "INVALID_REQUEST", status = 400) {
    super(message);
    this.name = "ApiValidationError";
    this.code = code;
    this.status = status;
  }
}

/** Run one SNMP Get request and return its JSON-safe typed binding. */
export async function handleSnmpGet(
  request: Request,
  clientFactory: SnmpClientFactory = createSnmpClient,
): Promise<Response> {
  let client: Snmp | undefined;
  try {
    assertLocalRequest(request);
    const input = await parseOperationRequest(request);
    client = clientFactory(input.options);
    const binding = await client.get(input.oid);
    return jsonResponse({ binding: serializeVarBind(binding) });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (client) await closeQuietly(client);
  }
}

/**
 * Run an SNMP Walk and return newline-delimited typed bindings as they arrive.
 * Cancelling the HTTP stream closes the SNMP client and releases its UDP socket.
 */
export async function handleSnmpWalk(
  request: Request,
  clientFactory: SnmpClientFactory = createSnmpClient,
): Promise<Response> {
  let client: Snmp | undefined;
  try {
    assertLocalRequest(request);
    const input = await parseOperationRequest(request);
    client = clientFactory(input.options);
    const iterator = client.walk(input.oid)[Symbol.asyncIterator]();
    let cancelled = false;
    let clientClosed = false;

    const closeClient = async (): Promise<void> => {
      if (clientClosed) return;
      clientClosed = true;
      await closeQuietly(client!);
    };

    const stream = new ReadableStream<Uint8Array>({
      /** Pull one binding per stream demand to preserve backpressure. */
      async pull(controller) {
        if (cancelled || clientClosed) return;
        try {
          const next = await iterator.next();
          if (cancelled) return;
          if (next.done) {
            controller.enqueue(encodeNdjsonLine({ event: "done" } satisfies WalkStreamEvent));
            controller.close();
            await closeClient();
            return;
          }
          controller.enqueue(encodeNdjsonLine({
            event: "binding",
            binding: serializeVarBind(next.value as VarBind),
          } satisfies WalkStreamEvent));
        } catch (error) {
          if (!cancelled) {
            controller.enqueue(encodeNdjsonLine({ event: "error", error: serializeError(error) } satisfies WalkStreamEvent));
            controller.close();
          }
          await closeClient();
        }
      },
      /** Close both the socket and iterator when the browser cancels its Walk. */
      async cancel() {
        cancelled = true;
        await closeClient();
        try {
          await iterator.return?.();
        } catch {
          // Closing the transport can reject an in-flight iterator operation.
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...safeHeaders,
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    });
  } catch (error) {
    if (client) await closeQuietly(client);
    return errorResponse(error);
  }
}

/** Shared response headers preventing caching and MIME-type sniffing. */
const safeHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** Validate body size/content type, parse JSON, and validate operation fields. */
async function parseOperationRequest(request: Request): Promise<SnmpOperationRequest> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiValidationError("Content-Type must be application/json", "UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ApiValidationError("Request body is too large", "REQUEST_TOO_LARGE", 413);
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw new ApiValidationError("Request body is too large", "REQUEST_TOO_LARGE", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiValidationError("Request body must contain valid JSON", "INVALID_JSON");
  }

  const record = asRecord(parsed, "Request body must be a JSON object");
  const options = parseSnmpOptions(record.options);
  if (typeof record.oid !== "string" || record.oid.length === 0 || record.oid.length > 512) {
    throw new ApiValidationError("A valid OID is required", "INVALID_OID");
  }
  if (!isValidOid(record.oid)) {
    throw new ApiValidationError("OID must be a valid dotted-decimal object identifier", "INVALID_OID");
  }
  return { options, oid: record.oid };
}

/** Validate dotted-decimal OID syntax without depending on library internals. */
function isValidOid(oid: string): boolean {
  const normalized = oid.startsWith(".") ? oid.slice(1) : oid;
  const arcs = normalized.split(".");
  if (arcs.length < 2 || arcs.some((arc) => !/^\d+$/.test(arc))) return false;
  const first = BigInt(arcs[0]!);
  const second = BigInt(arcs[1]!);
  return first <= 2n && (first === 2n || second <= 39n);
}

/** Validate and construct an allow-listed SNMP option object. */
function parseSnmpOptions(value: unknown): SnmpOptions {
  const input = asRecord(value, "options must be an object");
  if (typeof input.host !== "string" || isIP(input.host) === 0) {
    throw new ApiValidationError("host must be an IPv4 or IPv6 address", "INVALID_HOST");
  }
  const common = {
    host: input.host,
    ...(input.port === undefined ? {} : { port: integerInRange(input.port, 1, 65_535, "port") }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: integerInRange(input.timeoutMs, 1, MAX_TIMEOUT_MS, "timeoutMs") }),
    ...(input.retries === undefined ? {} : { retries: integerInRange(input.retries, 0, MAX_RETRIES, "retries") }),
  };

  if (input.version === "v1" || input.version === "v2c") {
    if (typeof input.community !== "string" || input.community.length === 0 || input.community.length > 255) {
      throw new ApiValidationError("community must contain between 1 and 255 characters", "INVALID_COMMUNITY");
    }
    return { ...common, version: input.version, community: input.community };
  }

  if (input.version !== "v3") {
    throw new ApiValidationError("version must be v1, v2c, or v3", "INVALID_VERSION");
  }
  const security = asRecord(input.security, "SNMPv3 security configuration is required");
  if (typeof security.username !== "string" || security.username.length === 0 || security.username.length > 255) {
    throw new ApiValidationError("SNMPv3 username must contain between 1 and 255 characters", "INVALID_USERNAME");
  }
  if (security.authProtocol !== undefined && security.authProtocol !== "sha1") {
    throw new ApiValidationError("Only the SNMPv3 SHA-1 authentication protocol is supported", "INVALID_AUTH_PROTOCOL");
  }
  if (security.securityLevel === "noAuthNoPriv") {
    return {
      ...common,
      version: "v3",
      security: { securityLevel: "noAuthNoPriv", username: security.username },
      ...parseContextName(input.contextName),
    };
  }

  const authPassword = validatePassphrase(security.authPassword, "authPassword");
  if (security.securityLevel === "authNoPriv") {
    return {
      ...common,
      version: "v3",
      security: { securityLevel: "authNoPriv", username: security.username, authPassword, authProtocol: "sha1" },
      ...parseContextName(input.contextName),
    };
  }
  if (security.securityLevel === "authPriv") {
    if (security.privacyProtocol !== undefined && security.privacyProtocol !== "des") {
      throw new ApiValidationError("Only the SNMPv3 DES privacy protocol is supported", "INVALID_PRIVACY_PROTOCOL");
    }
    const privacyPassword = validatePassphrase(security.privacyPassword, "privacyPassword");
    return {
      ...common,
      version: "v3",
      security: {
        securityLevel: "authPriv",
        username: security.username,
        authPassword,
        privacyPassword,
        authProtocol: "sha1",
        privacyProtocol: "des",
      },
      ...parseContextName(input.contextName),
    };
  }
  throw new ApiValidationError("Unsupported SNMPv3 security level", "INVALID_SECURITY_LEVEL");
}

/** Validate an optional SNMPv3 context name. */
function parseContextName(value: unknown): { contextName?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length > 255) {
    throw new ApiValidationError("contextName must be a string of at most 255 characters", "INVALID_CONTEXT_NAME");
  }
  return { contextName: value };
}

/** Validate an SNMPv3 passphrase length without retaining a transformed copy. */
function validatePassphrase(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ApiValidationError(`${field} is required`, "INVALID_PASSPHRASE");
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength < 8 || byteLength > 256) {
    throw new ApiValidationError(`${field} must contain between 8 and 256 UTF-8 bytes`, "INVALID_PASSPHRASE");
  }
  return value;
}

/** Convert an unknown JSON value to a string-keyed object. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiValidationError(message, "INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

/** Validate an integer field within its permitted inclusive range. */
function integerInRange(value: unknown, minimum: number, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApiValidationError(`${field} must be an integer from ${minimum} to ${maximum}`, `INVALID_${field.toUpperCase()}`);
  }
  return value;
}

/** Reject cross-origin or non-loopback request hosts to prevent local API exposure. */
function assertLocalRequest(request: Request): void {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    throw new ApiValidationError("Invalid request URL", "INVALID_URL", 403);
  }
  if (!isLoopbackHost(target.hostname)) {
    throw new ApiValidationError("This SNMP web API only accepts loopback requests", "LOCAL_ONLY", 403);
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  try {
    if (new URL(origin).origin !== target.origin) {
      throw new ApiValidationError("Cross-origin requests are not allowed", "CROSS_ORIGIN", 403);
    }
  } catch (error) {
    if (error instanceof ApiValidationError) throw error;
    throw new ApiValidationError("Invalid request Origin", "CROSS_ORIGIN", 403);
  }
}

/** Identify accepted IPv4/IPv6 loopback URL host names. */
function isLoopbackHost(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

/** Construct the library's default UDP-backed SNMP client. */
function createSnmpClient(options: SnmpOptions): Snmp {
  return new SnmpClient(options);
}

/** Close a client without allowing cleanup errors to hide the API result. */
async function closeQuietly(client: Snmp): Promise<void> {
  try {
    await client.close();
  } catch {
    // Do not replace a completed SNMP result with a socket cleanup error.
  }
}

/** Build a JSON response with the web API's safe default headers. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...safeHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

/** Return a sanitized JSON error response without exposing credentials. */
function errorResponse(error: unknown): Response {
  if (error instanceof ApiValidationError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
  }
  const safeError = serializeError(error);
  return jsonResponse({ error: safeError }, error instanceof SnmpError && error.code === "SNMP_TIMEOUT" ? 504 : 502);
}

/** Convert implementation errors into a bounded, JSON-safe message. */
function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiValidationError) return { code: error.code, message: error.message };
  if (error instanceof SnmpError) return { code: error.code, message: error.message.slice(0, 500) };
  return { code: "SNMP_OPERATION_FAILED", message: "SNMP operation failed" };
}
