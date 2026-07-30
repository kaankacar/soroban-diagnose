/**
 * Normalize: RawFailure -> canonical envelope (pre-resolution).
 * Picks the most specific error layer, resolves contract error codes through
 * the deployed wasm's spec, and records every degradation honestly.
 */

import type { Envelope, EnvelopeError, UnresolvedNote } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";
import type { RawFailure } from "./ingest.js";
import type { RpcSession } from "./rpc.js";
import { failedOp } from "./decode/txresult.js";
import { rootError } from "./decode/events.js";
import {
  CONTRACT_ERROR_ID,
  contractErrorRaw,
  hostErrorId,
  hostErrorRaw,
} from "./xdrnames.js";
import { resolveContractError } from "./decode/spec.js";

const SIM_HOST_ERROR_RE = /Error\(([A-Za-z]+),\s*(#?\w+)\)/;

export interface NormalizeResult {
  envelope: Envelope;
  raw: RawFailure;
}

export async function normalize(
  session: RpcSession | null,
  raw: RawFailure,
): Promise<NormalizeResult> {
  const unresolved: UnresolvedNote[] = raw.notes.map((detail) => ({
    reason: "input_incomplete" as const,
    detail,
  }));

  const op = raw.tx_result ? failedOp(raw.tx_result) : null;

  const error: EnvelopeError = {
    id: null,
    layer: null,
    raw: null,
    host_error: null,
    contract_error: null,
  };

  // Layer 4/3: contract or host error from diagnostic events.
  const rootErr = rootError(raw.facts);
  if (rootErr) {
    if (rootErr.error.contractCode !== null) {
      error.layer = "contract";
      error.id = CONTRACT_ERROR_ID;
      error.raw = contractErrorRaw(rootErr.error.contractCode);
      error.host_error = { type: "Contract", code: `#${rootErr.error.contractCode}` };
    } else {
      error.layer = "host";
      error.id = hostErrorId(rootErr.error.type, rootErr.error.code);
      error.raw = hostErrorRaw(rootErr.error.type, rootErr.error.code);
      error.host_error = { type: rootErr.error.type, code: rootErr.error.code };
    }
  }

  // Simulation error string is the fallback source for the host layer.
  if (!error.host_error && raw.sim_error) {
    const m = SIM_HOST_ERROR_RE.exec(raw.sim_error);
    if (m) {
      const [, type, code] = m;
      if (type === "Contract") {
        const num = Number(code!.replace("#", ""));
        error.layer = "contract";
        error.id = CONTRACT_ERROR_ID;
        error.raw = contractErrorRaw(num);
        error.host_error = { type: "Contract", code: code! };
      } else {
        error.layer = "host";
        error.id = hostErrorId(type!, code!);
        error.raw = hostErrorRaw(type!, code!);
        error.host_error = { type: type!, code: code! };
      }
    }
  }

  // The refundable-fee op result is more precise than the Budget error the
  // host reports while running out of the refundable portion — keep the op
  // identity in that case.
  if (
    op?.code === "INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE" &&
    error.host_error?.type === "Budget"
  ) {
    error.layer = "op";
    error.id = op.id;
    error.raw = op.code;
  }

  // Layer 2: operation result.
  if (!error.layer && op && op.code) {
    error.layer = "op";
    error.id = op.id;
    error.raw = op.code;
  } else if (!error.layer && op && !op.code) {
    error.layer = "op";
    error.id = op.id;
    error.raw = op.wrapper;
  }

  // Layer 1: transaction result.
  if (!error.layer && raw.tx_result && !raw.successful) {
    error.layer = "tx";
    error.id = raw.tx_result.tx_id;
    error.raw = raw.tx_result.tx_code;
  }

  // Contract error code -> name resolution (the headline transformation).
  if (error.layer === "contract" && error.host_error) {
    const code = Number(error.host_error.code.replace("#", ""));
    const contractId =
      (rootErr?.contract_id ?? null) || (raw.tx_context?.invocation?.contract_id ?? null);
    if (contractId && session) {
      const res = await resolveContractError(session, contractId, code);
      error.contract_error = res.info;
      if (!res.ok) {
        unresolved.push({
          reason: "contract_error_unresolved",
          detail: `Error(Contract, #${code}) could not be mapped to a name: ${res.detail}`,
        });
      } else if (res.ambiguous_with.length > 0) {
        unresolved.push({
          reason: "contract_error_unresolved",
          detail: `Code ${code} also matches ${res.ambiguous_with.join(", ")} in other error enums of the same spec; the first match was reported.`,
        });
      }
    } else {
      error.contract_error = {
        contract_id: contractId,
        code,
        name: null,
        doc: null,
        enum_name: null,
        resolved_from: null,
      };
      unresolved.push({
        reason: "contract_error_unresolved",
        detail: contractId
          ? "No RPC access to fetch the contract spec."
          : "The erroring contract could not be identified from events or the envelope.",
      });
    }
  }

  if (raw.successful) {
    unresolved.push({
      reason: "not_a_failure",
      detail:
        raw.input.kind === "simulation"
          ? "This simulation succeeded; there is nothing to diagnose."
          : "This transaction succeeded; there is nothing to diagnose.",
    });
  } else if (!error.layer && !raw.sim_restore_preamble) {
    unresolved.push({
      reason: "layer_missing",
      detail: "No error information could be extracted from the input at any layer.",
    });
  }

  const envelope: Envelope = {
    schema_version: SCHEMA_VERSION,
    network: raw.network,
    protocol_version: raw.protocol_version,
    input: raw.input,
    status: {
      tx: raw.tx_result?.tx_code ?? null,
      op: op?.code ?? (op ? op.wrapper : null),
      phase: raw.phase,
      successful: raw.successful,
    },
    error,
    diagnostic_events: raw.facts.views,
    diagnoses: [],
    eliminated: [],
    unresolved,
    references: [],
    transaction: raw.tx_context
      ? { ...raw.tx_context, failed_operation_index: op?.index ?? null }
      : null,
  };
  return { envelope, raw };
}
