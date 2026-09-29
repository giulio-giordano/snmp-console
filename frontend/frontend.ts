import type { SnmpOptions } from "@ptrsnake/ts-snmp";
import type { SerializedVarBind, WalkStreamEvent } from "../src/web/serialization.ts";

/** Bind the main form controls once when the Bun-bundled SPA is loaded. */
const form = getElement<HTMLFormElement>("#snmp-form");
const operationInput = getElement<HTMLSelectElement>("#operation");
const versionInput = getElement<HTMLSelectElement>("#version");
const securityLevelInput = getElement<HTMLSelectElement>("#security-level");
const communityGroup = getElement<HTMLElement>("#community-group");
const communityInput = getElement<HTMLInputElement>("#community");
const v3Group = getElement<HTMLElement>("#v3-group");
const usernameInput = getElement<HTMLInputElement>("#username");
const authPasswordInput = getElement<HTMLInputElement>("#auth-password");
const privacyPasswordInput = getElement<HTMLInputElement>("#privacy-password");
const authPasswordGroup = getElement<HTMLElement>("#auth-password-group");
const privacyPasswordGroup = getElement<HTMLElement>("#privacy-password-group");
const runButton = getElement<HTMLButtonElement>("#run-button");
const runButtonLabel = getElement<HTMLElement>("#run-button-label");
const cancelButton = getElement<HTMLButtonElement>("#cancel-button");
const statusPanel = getElement<HTMLElement>("#status");
const statusMessage = getElement<HTMLElement>("#status-message");
const resultCount = getElement<HTMLElement>("#result-count");
const resultsBody = getElement<HTMLTableSectionElement>("#results-body");
const oidLabel = getElement<HTMLElement>("#oid-label");
const oidHelp = getElement<HTMLElement>("#oid-help");
const emptyRow = getElement<HTMLElement>("#empty-row");

/** Active fetch controller used to stop an in-progress streamed Walk. */
let activeRequest: AbortController | undefined;
/** Number of bindings displayed for the current operation. */
let bindingCount = 0;

/** Update visible credentials and native form validation by SNMP version. */
function updateVersionFields(): void {
  const usesV3 = versionInput.value === "v3";
  communityGroup.hidden = usesV3;
  v3Group.hidden = !usesV3;
  communityInput.required = !usesV3;
  usernameInput.required = usesV3;
  updateSecurityFields();
}

/** Show only the credential fields required by the selected USM level. */
function updateSecurityFields(): void {
  const isV3 = versionInput.value === "v3";
  const needsAuth = isV3 && securityLevelInput.value !== "noAuthNoPriv";
  const needsPrivacy = isV3 && securityLevelInput.value === "authPriv";
  authPasswordGroup.hidden = !needsAuth;
  privacyPasswordGroup.hidden = !needsPrivacy;
  authPasswordInput.required = needsAuth;
  privacyPasswordInput.required = needsPrivacy;
}

/** Keep the OID label and submit action aligned with Get or Walk selection. */
function updateOperationFields(): void {
  const isWalk = operationInput.value === "walk";
  oidLabel.textContent = isWalk ? "Root OID" : "Object identifier";
  oidHelp.textContent = isWalk
    ? "Walks this OID and its descendants; results stream as they arrive."
    : "Reads the value of this exact OID.";
  runButtonLabel.textContent = isWalk ? "Run walk" : "Run get";
}

/** Build a version-discriminated configuration from the form. */
function collectOptions(): SnmpOptions {
  const base = {
    host: getElement<HTMLInputElement>("#host").value.trim(),
    port: readInteger("#port"),
    timeoutMs: readInteger("#timeout"),
    retries: readInteger("#retries"),
  };
  const version = versionInput.value;
  if (version === "v1" || version === "v2c") {
    return { ...base, version, community: communityInput.value };
  }

  const securityLevel = securityLevelInput.value;
  const security = securityLevel === "noAuthNoPriv"
    ? { securityLevel: "noAuthNoPriv" as const, username: usernameInput.value }
    : securityLevel === "authNoPriv"
      ? {
          securityLevel: "authNoPriv" as const,
          username: usernameInput.value,
          authPassword: authPasswordInput.value,
          authProtocol: "sha1" as const,
        }
      : {
          securityLevel: "authPriv" as const,
          username: usernameInput.value,
          authPassword: authPasswordInput.value,
          privacyPassword: privacyPasswordInput.value,
          authProtocol: "sha1" as const,
          privacyProtocol: "des" as const,
        };
  const contextName = getElement<HTMLInputElement>("#context-name").value;
  return { ...base, version: "v3", security, ...(contextName ? { contextName } : {}) };
}

/** Run Get or Walk and update the results without exposing credentials. */
async function runQuery(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const operation = operationInput.value === "get" ? "get" : "walk";
  let payload: { options: SnmpOptions; oid: string };
  try {
    payload = {
      options: collectOptions(),
      oid: getElement<HTMLInputElement>("#oid").value.trim(),
    };
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "Invalid query settings.");
    return;
  }
  clearResults();
  setBusy(true, operation === "walk");
  setStatus("running", operation === "walk" ? "Walking subtree…" : "Querying agent…");
  const controller = new AbortController();
  activeRequest = controller;

  try {
    if (operation === "get") {
      const response = await fetch("/api/snmp/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await readJsonResponse(response);
      appendBinding(body.binding as SerializedVarBind);
      setStatus("success", "Get completed.");
    } else {
      const response = await fetch("/api/snmp/walk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new Error("Walk response did not include a stream.");
      await consumeWalkStream(response.body);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      setStatus("idle", `Walk cancelled; ${bindingCount} binding${bindingCount === 1 ? "" : "s"} retained.`);
    } else {
      setStatus("error", error instanceof Error ? error.message : "SNMP request failed.");
    }
  } finally {
    activeRequest = undefined;
    setBusy(false, false);
  }
}

/** Read the JSON response from Get and surface API errors as ordinary Errors. */
async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: string } | undefined;
    throw new Error(error?.message ?? `Request failed with HTTP ${response.status}.`);
  }
  return body;
}

/** Read the server's NDJSON stream and append each binding as it arrives. */
async function consumeWalkStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let receivedDone = false;

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) receivedDone = handleWalkEvent(JSON.parse(line) as WalkStreamEvent) || receivedDone;
    }
    if (done) break;
  }
  if (pending.trim()) receivedDone = handleWalkEvent(JSON.parse(pending) as WalkStreamEvent) || receivedDone;
  if (!receivedDone) setStatus("success", `Walk completed with ${bindingCount} binding${bindingCount === 1 ? "" : "s"}.`);
}

/** Process one line from the streaming API, distinguishing end and error events. */
function handleWalkEvent(event: WalkStreamEvent): boolean {
  if (event.event === "binding") {
    appendBinding(event.binding);
    setStatus("running", `Receiving bindings… ${bindingCount} received.`);
    return false;
  }
  if (event.event === "done") {
    setStatus("success", `Walk completed with ${bindingCount} binding${bindingCount === 1 ? "" : "s"}.`);
    return true;
  }
  setStatus("error", event.error.message);
  return true;
}

/** Convert a non-success HTTP response to a user-facing error. */
async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return new Error(body.error?.message ?? `Request failed with HTTP ${response.status}.`);
  } catch {
    return new Error(`Request failed with HTTP ${response.status}.`);
  }
}

/** Add one safely rendered typed binding to the output table. */
function appendBinding(binding: SerializedVarBind): void {
  if (!binding || typeof binding.oid !== "string" || typeof binding.type !== "string") {
    throw new Error("Server returned a malformed VarBind.");
  }
  emptyRow.remove();
  const row = document.createElement("tr");
  row.append(makeCell(binding.oid), makeCell(binding.type), makeCell(formatValue(binding)));
  resultsBody.append(row);
  bindingCount += 1;
  resultCount.textContent = `${bindingCount} binding${bindingCount === 1 ? "" : "s"}`;
}

/** Render binary and BigInt encodings in a readable, explicit form. */
function formatValue(binding: SerializedVarBind): string {
  if (binding.value === null) return "null";
  if (binding.valueEncoding === "decimal") return `${binding.value} (decimal)`;
  if (binding.valueEncoding === "base64") {
    const encoded = String(binding.value);
    try {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if ([...text].every((character) => character >= " " || character === "\n" || character === "\r" || character === "\t")) {
        return text.length > 160 ? `${text.slice(0, 157)}…` : text;
      }
    } catch {
      // Non-text octets remain represented by their lossless base64 encoding.
    }
    return `base64: ${encoded}`;
  }
  return String(binding.value);
}

/** Construct a table cell using textContent to avoid interpreting agent data as HTML. */
function makeCell(value: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

/** Clear old rows and reset the displayed binding count. */
function clearResults(): void {
  resultsBody.replaceChildren(emptyRow);
  bindingCount = 0;
  resultCount.textContent = "0 bindings";
}

/** Set busy button states and expose cancellation only for active Walks. */
function setBusy(busy: boolean, canCancel: boolean): void {
  runButton.disabled = busy;
  versionInput.disabled = busy;
  operationInput.disabled = busy;
  cancelButton.hidden = !busy || !canCancel;
  if (canCancel) cancelButton.disabled = !busy;
}

/** Update the live query status with a visual state class. */
function setStatus(state: "idle" | "running" | "success" | "error", message: string): void {
  statusPanel.className = `status status-${state}`;
  statusMessage.textContent = message;
}

/** Read a numeric form input and reject invalid or empty values. */
function readInteger(selector: string): number {
  const value = Number(getElement<HTMLInputElement>(selector).value);
  if (!Number.isInteger(value)) throw new Error("Advanced numeric settings must be whole numbers.");
  return value;
}

/** Resolve a required DOM element or fail during page initialization. */
function getElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Required page element not found: ${selector}`);
  return element;
}

/** Initialize field visibility and bind form actions. */
versionInput.addEventListener("change", updateVersionFields);
securityLevelInput.addEventListener("change", updateSecurityFields);
operationInput.addEventListener("change", updateOperationFields);
form.addEventListener("submit", (event) => void runQuery(event));
cancelButton.addEventListener("click", () => activeRequest?.abort());
updateVersionFields();
updateOperationFields();
