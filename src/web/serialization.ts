import type { SnmpValueType, VarBind } from "@ptrsnake/ts-snmp";

/** JSON-safe value form used by the local web API. */
export type SerializedValue = string | number | null;

/** JSON-safe SNMP binding representation. */
export interface SerializedVarBind {
  /** Dotted-decimal OID associated with the value. */
  oid: string;
  /** Original SNMP syntax tag. */
  type: SnmpValueType;
  /** JSON-compatible value; see valueEncoding when not a native JSON value. */
  value: SerializedValue;
  /** Encoding applied to binary or 64-bit integer values. */
  valueEncoding?: "base64" | "decimal";
}

/** Serialize byte arrays and bigint values without losing their information. */
export function serializeVarBind(binding: VarBind): SerializedVarBind {
  if (binding.value instanceof Uint8Array) {
    return {
      oid: binding.oid,
      type: binding.type,
      value: Buffer.from(binding.value).toString("base64"),
      valueEncoding: "base64",
    };
  }
  if (typeof binding.value === "bigint") {
    return {
      oid: binding.oid,
      type: binding.type,
      value: binding.value.toString(10),
      valueEncoding: "decimal",
    };
  }
  return { oid: binding.oid, type: binding.type, value: binding.value };
}

/** Shape of a single line emitted by the streaming Walk API. */
export type WalkStreamEvent =
  | { event: "binding"; binding: SerializedVarBind }
  | { event: "done" }
  | { event: "error"; error: { code: string; message: string } };

/** Encode one JSON value as a newline-delimited UTF-8 stream chunk. */
export function encodeNdjsonLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}
