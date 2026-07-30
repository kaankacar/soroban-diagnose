/**
 * TransactionResult decoding: transaction and operation result layers.
 * Handles fee-bump unwrapping — the diagnosis should always speak about the
 * inner transaction the user actually cares about.
 */

import { xdr } from "@stellar/stellar-sdk";
import { opResultCode, opWrapperCodeName, txResultCodeId, txResultCodeName } from "../xdrnames.js";

export interface ParsedOpResult {
  index: number;
  /** "opINNER", or the wrapper failure ("opBAD_AUTH", "opNO_ACCOUNT", ...). */
  wrapper: string;
  /** Operation type in SDK camel form, e.g. "invokeHostFunction". Null when the wrapper failed. */
  op_type: string | null;
  /** Canonical code, e.g. "INVOKE_HOST_FUNCTION_TRAPPED". */
  code: string | null;
  /** Namespaced id, e.g. "op.invoke_host_function.trapped". */
  id: string | null;
  success: boolean;
}

export interface ParsedTxResult {
  /** Canonical code of the *effective* (inner, if fee-bumped) transaction. */
  tx_code: string;
  tx_id: string;
  fee_charged: string;
  fee_bump: boolean;
  /** Outer code when fee-bumped, e.g. "txFEE_BUMP_INNER_FAILED". */
  outer_tx_code: string | null;
  ops: ParsedOpResult[];
}

const SUCCESS_SUFFIXES = ["Success", "SuccessMultiple"]; // manageOffer etc. never hit these paths but be safe

function isSuccessCode(sdkName: string): boolean {
  return SUCCESS_SUFFIXES.some((s) => sdkName.endsWith(s));
}

function parseOpResults(results: InstanceType<typeof xdr.OperationResult>[]): ParsedOpResult[] {
  return results.map((op, index) => {
    const wrapperName = op.switch().name; // "opInner" | "opBadAuth" | ...
    if (wrapperName !== "opInner") {
      return {
        index,
        wrapper: opWrapperCodeName(wrapperName),
        op_type: null,
        code: null,
        id: `op.${wrapperName === "opBadAuth" ? "bad_auth" : wrapperName.replace(/^op/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`,
        success: false,
      };
    }
    const tr = op.tr();
    const opType = tr.switch().name; // OperationType camel name
    let codeSdk = "unknown";
    try {
      const inner = tr.value() as { switch?: () => { name: string } };
      if (inner && typeof inner.switch === "function") codeSdk = inner.switch().name;
    } catch {
      /* keep unknown */
    }
    const { name, id } = opResultCode(opType, codeSdk);
    return {
      index,
      wrapper: "opINNER",
      op_type: opType,
      code: name,
      id,
      success: isSuccessCode(codeSdk),
    };
  });
}

export function parseTransactionResult(resultXdrB64: string): ParsedTxResult {
  const tr = xdr.TransactionResult.fromXDR(resultXdrB64, "base64");
  const feeCharged = tr.feeCharged().toString();
  const result = tr.result();
  const codeSdk = result.switch().name;

  if (codeSdk === "txFeeBumpInnerFailed" || codeSdk === "txFeeBumpInnerSuccess") {
    const inner = result.innerResultPair().result();
    const innerCodeSdk = inner.result().switch().name;
    let ops: ParsedOpResult[] = [];
    try {
      const r = inner.result();
      if (typeof (r as { results?: unknown }).results === "function") {
        ops = parseOpResults(r.results());
      }
    } catch {
      ops = [];
    }
    return {
      tx_code: txResultCodeName(innerCodeSdk),
      tx_id: txResultCodeId(innerCodeSdk),
      fee_charged: feeCharged,
      fee_bump: true,
      outer_tx_code: txResultCodeName(codeSdk),
      ops,
    };
  }

  let ops: ParsedOpResult[] = [];
  try {
    if (typeof (result as { results?: unknown }).results === "function") {
      ops = parseOpResults(result.results());
    }
  } catch {
    ops = [];
  }
  return {
    tx_code: txResultCodeName(codeSdk),
    tx_id: txResultCodeId(codeSdk),
    fee_charged: feeCharged,
    fee_bump: false,
    outer_tx_code: null,
    ops,
  };
}

/** The first failed operation, or null when all ops succeeded / none present. */
export function failedOp(parsed: ParsedTxResult): ParsedOpResult | null {
  return parsed.ops.find((o) => !o.success) ?? null;
}
