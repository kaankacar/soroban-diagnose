/**
 * Contract error code -> enum variant name resolution.
 *
 * This is the single highest-value transformation in the repo:
 * `Error(Contract, #7)` is opaque until mapped through the deployed wasm's
 * `contractspecv0` section. The mapping is mechanical and must never guess:
 * every degradation path returns `resolved_from: null` rather than a made-up
 * name.
 */

import { xdr, Address, StrKey } from "@stellar/stellar-sdk";
import jsxdr from "@stellar/js-xdr";
import type { ContractErrorInfo } from "../types.js";
import type { RpcSession } from "../rpc.js";
import { contractSpecSection } from "./wasm.js";

export interface SpecErrorCase {
  name: string;
  value: number;
  doc: string | null;
}

export interface SpecErrorEnum {
  name: string;
  lib: string;
  cases: SpecErrorCase[];
}

/**
 * Stellar Asset Contract built-in error codes.
 * Source of truth: rs-soroban-env soroban-env-host/src/builtin_contracts/contract_error.rs
 * (verified 2026-07-30). Code 1 is reserved.
 */
export const SAC_ERRORS: Record<number, { name: string; doc: string }> = {
  2: { name: "OperationNotSupportedError", doc: "The operation is not supported by this built-in contract." },
  3: { name: "AlreadyInitializedError", doc: "The contract has already been initialized." },
  4: { name: "UnauthorizedError", doc: "The caller is not authorized (e.g. trustline or account is deauthorized, or asset auth flags forbid this)." },
  5: { name: "AuthenticationError", doc: "Authentication failed for the invocation." },
  6: { name: "AccountMissingError", doc: "The referenced classic account does not exist on the ledger." },
  7: { name: "AccountIsNotClassic", doc: "The address is a contract, but a classic account was required." },
  8: { name: "NegativeAmountError", doc: "A negative amount was supplied where a non-negative one is required." },
  9: { name: "AllowanceError", doc: "The allowance is insufficient or the expiration is invalid." },
  10: { name: "BalanceError", doc: "The balance is insufficient for the requested operation, or the balance would exceed limits (e.g. trustline limit)." },
  11: { name: "BalanceDeauthorizedError", doc: "The balance (trustline) is deauthorized and cannot send or receive." },
  12: { name: "OverflowError", doc: "An arithmetic overflow occurred." },
  13: { name: "TrustlineMissingError", doc: "The account is missing a trustline for the asset." },
  14: { name: "InsufficientAccountReserve", doc: "The account does not hold enough XLM reserve for this operation." },
  15: { name: "TooManyAccountSubentries", doc: "The account has reached the ledger's subentry limit." },
};

/** Decode the raw contractspecv0 payload into a stream of ScSpecEntry. */
export function parseSpecEntries(payload: Uint8Array): InstanceType<typeof xdr.ScSpecEntry>[] {
  const entries: InstanceType<typeof xdr.ScSpecEntry>[] = [];
  const reader = new jsxdr.XdrReader(Buffer.from(payload));
  while (!reader.eof) {
    // The SDK types `.read` as taking a Buffer, but it accepts an XdrReader
    // (that is how js-xdr consumes streams internally).
    entries.push(xdr.ScSpecEntry.read(reader as unknown as Buffer));
  }
  return entries;
}

export function errorEnumsFromEntries(
  entries: InstanceType<typeof xdr.ScSpecEntry>[],
): SpecErrorEnum[] {
  const out: SpecErrorEnum[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== "scSpecEntryUdtErrorEnumV0") continue;
    const e = entry.udtErrorEnumV0();
    out.push({
      name: e.name().toString(),
      lib: e.lib().toString(),
      cases: e.cases().map((c) => ({
        name: c.name().toString(),
        value: c.value(),
        doc: c.doc().toString() || null,
      })),
    });
  }
  return out;
}

export interface ResolutionFailure {
  reason:
    | "contract_not_found"
    | "wasm_not_found"
    | "no_spec_section"
    | "no_error_enum"
    | "code_not_in_enum"
    | "rpc_unavailable";
  detail: string;
}

export interface ResolutionSuccess {
  info: ContractErrorInfo;
  /** All enums inspected — surfaced when the same value appears in several. */
  ambiguous_with: string[];
}

export type Resolution =
  | ({ ok: true } & ResolutionSuccess)
  | ({ ok: false } & ResolutionFailure & { info: ContractErrorInfo });

function unresolved(contractId: string | null, code: number): ContractErrorInfo {
  return {
    contract_id: contractId,
    code,
    name: null,
    doc: null,
    enum_name: null,
    resolved_from: null,
  };
}

/** Resolve against already-parsed error enums (pure, no I/O). */
export function resolveFromEnums(
  enums: SpecErrorEnum[],
  contractId: string | null,
  code: number,
): Resolution {
  if (enums.length === 0) {
    return {
      ok: false,
      reason: "no_error_enum",
      detail: "The contract spec contains no error enum definitions.",
      info: unresolved(contractId, code),
    };
  }
  const hits: { enumName: string; c: SpecErrorCase }[] = [];
  for (const en of enums) {
    for (const c of en.cases) {
      if (c.value === code) hits.push({ enumName: en.name, c });
    }
  }
  if (hits.length === 0) {
    return {
      ok: false,
      reason: "code_not_in_enum",
      detail: `Code ${code} is not defined in any error enum (${enums
        .map((e) => e.name)
        .join(", ")}) of the contract spec.`,
      info: unresolved(contractId, code),
    };
  }
  const first = hits[0]!;
  return {
    ok: true,
    info: {
      contract_id: contractId,
      code,
      name: first.c.name,
      doc: first.c.doc,
      enum_name: first.enumName,
      resolved_from: "contractspecv0",
    },
    ambiguous_with: hits.slice(1).map((h) => `${h.enumName}.${h.c.name}`),
  };
}

/** Ledger key for a contract's instance entry. */
export function contractInstanceKey(contractId: string): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )
    .toXDR("base64");
}

export function contractCodeKey(wasmHash: Buffer): string {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHash }),
  ).toXDR("base64");
}

export interface InstanceInfo {
  executable: "wasm" | "stellar_asset";
  wasmHash: Buffer | null;
  /** Instance storage as decoded key/value summaries (for SAC asset identification). */
  storage: Map<string, InstanceType<typeof xdr.ScVal>>;
}

export function decodeInstance(entryXdrB64: string): InstanceInfo | null {
  const data = xdr.LedgerEntryData.fromXDR(entryXdrB64, "base64");
  if (data.switch().name !== "contractData") return null;
  const val = data.contractData().val();
  if (val.switch().name !== "scvContractInstance") return null;
  const inst = val.instance();
  const exec = inst.executable();
  const storage = new Map<string, InstanceType<typeof xdr.ScVal>>();
  for (const kv of inst.storage() ?? []) {
    storage.set(kv.key().toXDR("base64"), kv.val());
  }
  if (exec.switch().name === "contractExecutableStellarAsset") {
    return { executable: "stellar_asset", wasmHash: null, storage };
  }
  return { executable: "wasm", wasmHash: exec.wasmHash(), storage };
}

/**
 * Full resolution pipeline: contract id -> instance -> wasm -> spec -> name.
 * Every failure mode degrades to `resolved_from: null` with a reason.
 */
export async function resolveContractError(
  session: RpcSession,
  contractId: string,
  code: number,
): Promise<Resolution> {
  if (!StrKey.isValidContract(contractId)) {
    return {
      ok: false,
      reason: "contract_not_found",
      detail: `"${contractId}" is not a valid contract address.`,
      info: unresolved(contractId, code),
    };
  }
  let instanceEntry;
  try {
    const key = contractInstanceKey(contractId);
    const entries = await session.getLedgerEntries([key]);
    instanceEntry = entries.get(key);
  } catch (e) {
    return {
      ok: false,
      reason: "rpc_unavailable",
      detail: `Could not fetch the contract instance: ${(e as Error).message}`,
      info: unresolved(contractId, code),
    };
  }
  if (!instanceEntry) {
    return {
      ok: false,
      reason: "contract_not_found",
      detail: `No contract instance found on this network for ${contractId}.`,
      info: unresolved(contractId, code),
    };
  }
  const inst = decodeInstance(instanceEntry.xdr);
  if (!inst) {
    return {
      ok: false,
      reason: "contract_not_found",
      detail: `Ledger entry for ${contractId} is not a contract instance.`,
      info: unresolved(contractId, code),
    };
  }

  if (inst.executable === "stellar_asset") {
    const sac = SAC_ERRORS[code];
    if (!sac) {
      return {
        ok: false,
        reason: "code_not_in_enum",
        detail: `Code ${code} is not a known Stellar Asset Contract error code.`,
        info: unresolved(contractId, code),
      };
    }
    return {
      ok: true,
      info: {
        contract_id: contractId,
        code,
        name: sac.name,
        doc: sac.doc,
        enum_name: "ContractError (built-in Stellar Asset Contract)",
        resolved_from: "sac_builtin",
      },
      ambiguous_with: [],
    };
  }

  let codeEntry;
  try {
    const codeKey = contractCodeKey(inst.wasmHash!);
    const entries = await session.getLedgerEntries([codeKey]);
    codeEntry = entries.get(codeKey);
  } catch (e) {
    return {
      ok: false,
      reason: "rpc_unavailable",
      detail: `Could not fetch the contract wasm: ${(e as Error).message}`,
      info: unresolved(contractId, code),
    };
  }
  if (!codeEntry) {
    return {
      ok: false,
      reason: "wasm_not_found",
      detail: `Wasm ${inst.wasmHash!.toString("hex")} not found on this network.`,
      info: unresolved(contractId, code),
    };
  }
  const codeData = xdr.LedgerEntryData.fromXDR(codeEntry.xdr, "base64");
  const wasm = codeData.contractCode().code();

  let section: Uint8Array | null;
  try {
    section = contractSpecSection(wasm);
  } catch (e) {
    return {
      ok: false,
      reason: "no_spec_section",
      detail: `Deployed wasm could not be walked: ${(e as Error).message}`,
      info: unresolved(contractId, code),
    };
  }
  if (!section) {
    return {
      ok: false,
      reason: "no_spec_section",
      detail: "Deployed wasm has no contractspecv0 custom section.",
      info: unresolved(contractId, code),
    };
  }

  let enums: SpecErrorEnum[];
  try {
    enums = errorEnumsFromEntries(parseSpecEntries(section));
  } catch (e) {
    return {
      ok: false,
      reason: "no_spec_section",
      detail: `contractspecv0 section failed to decode: ${(e as Error).message}`,
      info: unresolved(contractId, code),
    };
  }
  return resolveFromEnums(enums, contractId, code);
}
