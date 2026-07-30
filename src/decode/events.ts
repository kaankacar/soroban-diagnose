/**
 * Diagnostic event decoding and fact extraction.
 *
 * The op result rarely says more than "TRAPPED"; the actual detail lives in
 * diagnostic events. We decode them into a compact human view and separately
 * extract structured facts (host errors, call chain) the resolver matches on.
 */

import { xdr, StrKey } from "@stellar/stellar-sdk";
import type { DiagnosticEventView } from "../types.js";
import { scValDisplay, scErrorView, type ScErrorView } from "./scval.js";

export interface DiagnosticError {
  error: ScErrorView;
  /** Human message from the event data, when present. */
  message: string | null;
  /** Extra args attached to the message. */
  args: unknown[];
  contract_id: string | null;
  in_successful_contract_call: boolean;
}

export interface DiagnosticFacts {
  /** Every error event, in emission order (oldest first). */
  errors: DiagnosticError[];
  /** fn_call chain, in emission order. */
  calls: { contract_id: string | null; function_name: string | null }[];
  /** All decoded events (for the envelope view). */
  views: DiagnosticEventView[];
}

function contractIdOf(event: InstanceType<typeof xdr.ContractEvent>): string | null {
  try {
    const raw = event.contractId();
    if (!raw) return null;
    return StrKey.encodeContract(raw as unknown as Buffer);
  } catch {
    return null;
  }
}

export function decodeDiagnosticEvents(eventsXdr: string[]): DiagnosticFacts {
  const facts: DiagnosticFacts = { errors: [], calls: [], views: [] };
  for (const b64 of eventsXdr) {
    let ev: InstanceType<typeof xdr.DiagnosticEvent>;
    try {
      ev = xdr.DiagnosticEvent.fromXDR(b64, "base64");
    } catch {
      continue; // tolerate junk; a bad event must not sink the diagnosis
    }
    ingestEvent(facts, ev.event(), ev.inSuccessfulContractCall());
  }
  return facts;
}

/** Contract events from tx meta (not wrapped in DiagnosticEvent). */
export function decodeContractEvents(events: InstanceType<typeof xdr.ContractEvent>[]): DiagnosticFacts {
  const facts: DiagnosticFacts = { errors: [], calls: [], views: [] };
  for (const ev of events) ingestEvent(facts, ev, true);
  return facts;
}

function ingestEvent(
  facts: DiagnosticFacts,
  event: InstanceType<typeof xdr.ContractEvent>,
  inSuccessfulCall: boolean,
): void {
  let topics: InstanceType<typeof xdr.ScVal>[] = [];
  let data: InstanceType<typeof xdr.ScVal> | null = null;
  try {
    const body = event.body().v0();
    topics = body.topics();
    data = body.data();
  } catch {
    return;
  }
  const cid = contractIdOf(event);
  const view: DiagnosticEventView = {
    contract_id: cid,
    type: event.type().name.replace(/^contractEventType/, "").toLowerCase(),
    topics: topics.map(scValDisplay),
    data: data ? scValDisplay(data) : null,
    in_successful_contract_call: inSuccessfulCall,
  };
  facts.views.push(view);

  const topic0 = firstSymbol(topics[0]);

  if (topic0 === "error" && topics[1] && topics[1].switch().name === "scvError") {
    const { message, args } = errorMessage(data);
    facts.errors.push({
      error: scErrorView(topics[1].error()),
      message,
      args,
      contract_id: cid,
      in_successful_contract_call: inSuccessfulCall,
    });
    return;
  }

  if (topic0 === "fn_call") {
    facts.calls.push({
      contract_id: fnCallTarget(topics[1]) ?? cid,
      function_name: topics[2] ? firstSymbol(topics[2]) : null,
    });
  }
}

function firstSymbol(v: InstanceType<typeof xdr.ScVal> | undefined): string | null {
  if (!v) return null;
  try {
    if (v.switch().name === "scvSymbol") return v.sym().toString();
    if (v.switch().name === "scvString") return v.str().toString();
  } catch {
    /* fallthrough */
  }
  return null;
}

/** fn_call encodes the callee as Bytes (contract hash) or Address. */
function fnCallTarget(v: InstanceType<typeof xdr.ScVal> | undefined): string | null {
  if (!v) return null;
  try {
    if (v.switch().name === "scvBytes") return StrKey.encodeContract(v.bytes());
    if (v.switch().name === "scvAddress") {
      const disp = scValDisplay(v);
      return typeof disp === "string" ? disp : null;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Error event data is either a string message or a vec of [message, ...args]. */
function errorMessage(data: InstanceType<typeof xdr.ScVal> | null): {
  message: string | null;
  args: unknown[];
} {
  if (!data) return { message: null, args: [] };
  try {
    if (data.switch().name === "scvString") return { message: data.str().toString(), args: [] };
    if (data.switch().name === "scvSymbol") return { message: data.sym().toString(), args: [] };
    if (data.switch().name === "scvVec") {
      const items = data.vec() ?? [];
      const message = firstSymbol(items[0]) ?? (typeof scValDisplay(items[0]!) === "string" ? (scValDisplay(items[0]!) as string) : null);
      return { message, args: items.slice(1).map(scValDisplay) };
    }
  } catch {
    /* fallthrough */
  }
  return { message: null, args: [scValDisplay(data)] };
}

/**
 * Pick the root-cause error from an event stream: the first error emitted in
 * a frame that did not ultimately succeed. Host escalation re-reports the
 * same error several times ("escalating…", "caught error from function",
 * "contract call failed") — the first specific report wins.
 */
export function rootError(facts: DiagnosticFacts): DiagnosticError | null {
  const failing = facts.errors.filter((e) => !e.in_successful_contract_call);
  const pool = failing.length > 0 ? failing : facts.errors;
  if (pool.length === 0) return null;
  // Prefer the first error carrying a contract code; otherwise first error.
  return pool.find((e) => e.error.contractCode !== null) ?? pool[0]!;
}
