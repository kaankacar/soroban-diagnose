/**
 * Ingest: turn any accepted input (tx hash, simulation response, raw XDR)
 * into one RawFailure struct. Missing layers are recorded as null — never an
 * error. Read-only: this module never signs or submits anything.
 */

import { xdr } from "@stellar/stellar-sdk";
import type {
  DiagnoseInput,
  EnvelopeInput,
  FailurePhase,
  Network,
  TransactionContext,
} from "./types.js";
import { NETWORK_PASSPHRASES, RpcSession, type GetTransactionResponse } from "./rpc.js";
import { decodeDiagnosticEvents, type DiagnosticFacts } from "./decode/events.js";
import { parseTransactionResult, type ParsedTxResult } from "./decode/txresult.js";
import { parseEnvelope } from "./decode/txenvelope.js";

export interface SimRestorePreamble {
  minResourceFee: string;
  transactionData: string;
}

export interface RawFailure {
  input: EnvelopeInput;
  phase: FailurePhase;
  network: Network;
  protocol_version: number | null;
  latest_ledger: number | null;
  tx_result: ParsedTxResult | null;
  tx_context: TransactionContext | null;
  facts: DiagnosticFacts;
  /** Raw simulation error string, when the input was a failed simulation. */
  sim_error: string | null;
  sim_restore_preamble: SimRestorePreamble | null;
  successful: boolean;
  /** Ingest-level notes that must surface in `unresolved`. */
  notes: string[];
}

const EMPTY_FACTS: DiagnosticFacts = { errors: [], calls: [], views: [] };

function emptyRaw(input: EnvelopeInput, network: Network): RawFailure {
  return {
    input,
    phase: "unknown",
    network,
    protocol_version: null,
    latest_ledger: null,
    tx_result: null,
    tx_context: null,
    facts: { errors: [], calls: [], views: [] },
    sim_error: null,
    sim_restore_preamble: null,
    successful: false,
    notes: [],
  };
}

async function networkInfo(
  session: RpcSession | null,
): Promise<{ network: Network; protocol: number | null; latest: number | null }> {
  if (!session) return { network: "unknown", protocol: null, latest: null };
  try {
    const [net, latest] = await Promise.all([session.getNetwork(), session.getLatestLedger()]);
    return {
      network: NETWORK_PASSPHRASES[net.passphrase] ?? net.passphrase,
      protocol: latest.protocolVersion ?? net.protocolVersion ?? null,
      latest: latest.sequence,
    };
  } catch {
    return { network: "unknown", protocol: null, latest: null };
  }
}

/* ------------------------------------------------------------------ */
/* tx hash                                                              */
/* ------------------------------------------------------------------ */

export async function ingestTxHash(session: RpcSession, hash: string): Promise<RawFailure> {
  const input: EnvelopeInput = { kind: "tx_hash", ref: hash };
  const { network, protocol, latest } = await networkInfo(session);
  const raw = emptyRaw(input, network);
  raw.protocol_version = protocol;
  raw.latest_ledger = latest;

  let res: GetTransactionResponse;
  try {
    res = await session.getTransaction(hash);
  } catch (e) {
    raw.notes.push(`getTransaction failed: ${(e as Error).message}`);
    return raw;
  }

  if (res.status === "NOT_FOUND") {
    raw.notes.push(
      `Transaction ${hash} was not found on ${network}. It may be outside the RPC retention window` +
        (res.oldestLedger ? ` (oldest retained ledger: ${res.oldestLedger})` : "") +
        `, never submitted, or on a different network.`,
    );
    return raw;
  }

  raw.phase = "apply";
  raw.successful = res.status === "SUCCESS";

  if (res.resultXdr) {
    try {
      raw.tx_result = parseTransactionResult(res.resultXdr);
    } catch (e) {
      raw.notes.push(`resultXdr failed to decode: ${(e as Error).message}`);
    }
  }
  if (res.envelopeXdr) {
    try {
      raw.tx_context = parseEnvelope(res.envelopeXdr);
      raw.tx_context.hash = res.txHash ?? hash;
      raw.tx_context.ledger = res.ledger ?? null;
      raw.tx_context.created_at = res.createdAt ? Number(res.createdAt) : null;
    } catch (e) {
      raw.notes.push(`envelopeXdr failed to decode: ${(e as Error).message}`);
    }
  }

  // Diagnostic events: prefer the events field (RPC >= 23), fall back to
  // the legacy top-level field, then to digging through the meta.
  const eventXdrs = res.events?.diagnosticEventsXdr ?? res.diagnosticEventsXdr ?? null;
  if (eventXdrs && eventXdrs.length > 0) {
    raw.facts = decodeDiagnosticEvents(eventXdrs);
  } else if (res.resultMetaXdr) {
    raw.facts = factsFromMeta(res.resultMetaXdr, raw.notes);
  }
  if (raw.facts.views.length === 0 && !raw.successful) {
    raw.notes.push(
      "No diagnostic events were available for this transaction. The RPC node may not have diagnostic events enabled; root-cause detail below the operation layer is limited.",
    );
  }
  return raw;
}

function factsFromMeta(metaXdrB64: string, notes: string[]): DiagnosticFacts {
  try {
    const meta = xdr.TransactionMeta.fromXDR(metaXdrB64, "base64");
    switch (meta.switch()) {
      case 3: {
        const soroban = meta.v3().sorobanMeta();
        if (!soroban) return EMPTY_FACTS;
        const events = soroban.diagnosticEvents() ?? [];
        return decodeDiagnosticEvents(events.map((e) => e.toXDR("base64")));
      }
      case 4: {
        const v4 = meta.v4();
        const events = v4.diagnosticEvents() ?? [];
        return decodeDiagnosticEvents(events.map((e) => e.toXDR("base64")));
      }
      default:
        return EMPTY_FACTS;
    }
  } catch (e) {
    notes.push(`resultMetaXdr failed to decode: ${(e as Error).message}`);
    return EMPTY_FACTS;
  }
}

/* ------------------------------------------------------------------ */
/* simulation response                                                  */
/* ------------------------------------------------------------------ */

interface SimResponseShape {
  error?: string;
  events?: string[];
  diagnosticEventsXdr?: string[];
  restorePreamble?: { minResourceFee?: string; transactionData?: string };
  transactionData?: string;
  minResourceFee?: string;
  results?: unknown[];
  latestLedger?: number;
}

export async function ingestSimulation(
  session: RpcSession | null,
  response: unknown,
  ref?: string,
  requestXdr?: string,
): Promise<RawFailure> {
  const input: EnvelopeInput = { kind: "simulation", ref: ref ?? null };
  const { network, protocol, latest } = await networkInfo(session);
  const raw = emptyRaw(input, network);
  raw.protocol_version = protocol;
  raw.latest_ledger = latest;
  raw.phase = "simulation";

  if (requestXdr) {
    try {
      raw.tx_context = parseEnvelope(requestXdr.trim());
    } catch (e) {
      raw.notes.push(`request_xdr failed to decode as a TransactionEnvelope: ${(e as Error).message}`);
    }
  }

  let sim = response as SimResponseShape & { result?: SimResponseShape; jsonrpc?: string };
  if (sim && typeof sim === "object" && sim.jsonrpc && sim.result) {
    sim = sim.result as SimResponseShape;
  }
  if (!sim || typeof sim !== "object") {
    raw.notes.push("Simulation input is not a JSON object.");
    return raw;
  }

  raw.latest_ledger = raw.latest_ledger ?? sim.latestLedger ?? null;

  const eventXdrs = sim.events ?? sim.diagnosticEventsXdr ?? [];
  if (Array.isArray(eventXdrs) && eventXdrs.length > 0) {
    raw.facts = decodeDiagnosticEvents(eventXdrs.filter((e): e is string => typeof e === "string"));
  }

  if (typeof sim.error === "string" && sim.error.length > 0) {
    raw.sim_error = sim.error;
  } else {
    raw.successful = true;
    if (sim.restorePreamble && sim.restorePreamble.transactionData) {
      // A "successful" simulation that requires restoration is exactly the
      // archived-entry situation users need explained.
      raw.successful = false;
      raw.sim_restore_preamble = {
        minResourceFee: sim.restorePreamble.minResourceFee ?? "0",
        transactionData: sim.restorePreamble.transactionData,
      };
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* raw XDR                                                              */
/* ------------------------------------------------------------------ */

type XdrShape = "transaction_envelope" | "transaction_result" | "transaction_meta" | "diagnostic_event";

export function sniffXdr(base64: string): XdrShape | null {
  const attempts: [XdrShape, () => void][] = [
    ["transaction_envelope", () => xdr.TransactionEnvelope.fromXDR(base64, "base64")],
    ["transaction_result", () => xdr.TransactionResult.fromXDR(base64, "base64")],
    ["transaction_meta", () => xdr.TransactionMeta.fromXDR(base64, "base64")],
    ["diagnostic_event", () => xdr.DiagnosticEvent.fromXDR(base64, "base64")],
  ];
  for (const [shape, attempt] of attempts) {
    try {
      attempt();
      return shape;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function ingestXdr(session: RpcSession | null, base64: string): Promise<RawFailure> {
  const trimmed = base64.trim();
  const input: EnvelopeInput = {
    kind: "xdr",
    ref: trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed,
  };
  const { network, protocol, latest } = await networkInfo(session);
  const raw = emptyRaw(input, network);
  raw.protocol_version = protocol;
  raw.latest_ledger = latest;

  const shape = sniffXdr(trimmed);
  switch (shape) {
    case "transaction_result": {
      raw.tx_result = parseTransactionResult(trimmed);
      // A bare TransactionResult with no ledger context is what
      // sendTransaction hands back on rejection.
      raw.phase = "submission";
      raw.successful = raw.tx_result.tx_code === "txSUCCESS";
      return raw;
    }
    case "transaction_envelope": {
      raw.tx_context = parseEnvelope(trimmed);
      if (session) {
        // Read-only what-if: run the envelope through simulateTransaction.
        try {
          const sim = await session.simulateTransaction(trimmed);
          const simRaw = await ingestSimulation(session, sim, input.ref ?? undefined);
          simRaw.input = input;
          simRaw.tx_context = raw.tx_context;
          simRaw.notes.push(
            "Input was a transaction envelope; it was re-simulated read-only against the current ledger state. Results reflect state now, not at original submission time.",
          );
          return simRaw;
        } catch (e) {
          raw.notes.push(`simulateTransaction failed: ${(e as Error).message}`);
        }
      } else {
        raw.notes.push(
          "Input was a transaction envelope with no failure information and no RPC access; only static context was extracted.",
        );
      }
      return raw;
    }
    case "transaction_meta": {
      raw.facts = factsFromMeta(trimmed, raw.notes);
      raw.phase = "apply";
      return raw;
    }
    case "diagnostic_event": {
      raw.facts = decodeDiagnosticEvents([trimmed]);
      raw.phase = "unknown";
      return raw;
    }
    default:
      raw.notes.push(
        "Input did not decode as TransactionEnvelope, TransactionResult, TransactionMeta, or DiagnosticEvent XDR.",
      );
      return raw;
  }
}

export async function ingest(session: RpcSession | null, input: DiagnoseInput): Promise<RawFailure> {
  switch (input.kind) {
    case "tx_hash": {
      if (!session) {
        const raw = emptyRaw({ kind: "tx_hash", ref: input.hash }, "unknown");
        raw.notes.push("A tx hash input requires RPC access, and none was configured.");
        return raw;
      }
      return ingestTxHash(session, input.hash);
    }
    case "simulation":
      return ingestSimulation(session, input.response, input.ref, input.request_xdr);
    case "xdr":
      return ingestXdr(session, input.base64);
  }
}
