/**
 * DEV-ONLY fixture recorder. For each known real failure (testnet manifest
 * entries + wild mainnet captures), runs diagnose() against live RPC with a
 * RecordingTransport and writes an offline replay fixture.
 *
 * Ground-truth labels come from how each failure was constructed (we caused
 * them deliberately), NOT from the tool's output — wild mainnet captures are
 * left unlabeled (coverage-only) unless a label is passed explicitly.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { diagnose } from "../src/index.js";
import { HttpTransport, RecordingTransport, NETWORK_RPC } from "../src/rpc.js";
import type { DiagnoseInput } from "../src/types.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");
mkdirSync(FIXTURE_DIR, { recursive: true });

/** Ground-truth labels for the generated scenarios (by construction). */
const LABELS: Record<
  string,
  { top_cause: string; error_id: string; contract_error_name?: string; confirmed: boolean; must_not_fire?: string[] }
> = {
  "onchain-contract-error-1": {
    top_cause: "contract_error_resolved",
    error_id: "soroban.contract.error",
    contract_error_name: "InsufficientBalance",
    confirmed: true,
    must_not_fire: ["sac_balance_insufficient", "contract_error_unresolved"],
  },
  "onchain-contract-error-7": {
    top_cause: "contract_error_resolved",
    error_id: "soroban.contract.error",
    contract_error_name: "InvalidAmount",
    confirmed: true,
  },
  "onchain-wasm-panic": {
    top_cause: "contract_panicked",
    error_id: "soroban.host.wasm_vm.invalid_action",
    confirmed: true,
    must_not_fire: ["contract_error_resolved"],
  },
  "onchain-budget-exceeded": {
    top_cause: "budget_exceeded_declared_too_low",
    error_id: "soroban.host.budget.exceeded_limit",
    confirmed: true,
    must_not_fire: ["budget_exceeded_at_network_cap", "entry_archived"],
  },
  "onchain-sac-balance": {
    top_cause: "auth_invocation_mismatch",
    error_id: "soroban.host.auth.invalid_action",
    confirmed: true,
    must_not_fire: ["sac_balance_insufficient", "auth_entry_not_signed", "auth_signature_expired"],
  },
  "onchain-sac-missing-trustline": {
    top_cause: "sac_trustline_missing",
    error_id: "soroban.contract.error",
    contract_error_name: "TrustlineMissingError",
    confirmed: true,
    must_not_fire: ["sac_balance_insufficient"],
  },
  "onchain-auth-unsigned": {
    top_cause: "auth_entry_not_signed",
    error_id: "soroban.host.auth.invalid_action",
    confirmed: true,
    must_not_fire: ["auth_signature_expired"],
  },
  "onchain-auth-expired": {
    top_cause: "auth_signature_expired",
    error_id: "soroban.host.auth.invalid_input",
    confirmed: true,
    must_not_fire: ["auth_entry_not_signed"],
  },
  "send-bad-seq": { top_cause: "tx_bad_seq", error_id: "tx.bad_seq", confirmed: true, must_not_fire: ["tx_too_late"] },
  "send-insufficient-fee": { top_cause: "tx_insufficient_fee", error_id: "tx.insufficient_fee", confirmed: true },
  "send-too-late": { top_cause: "tx_too_late", error_id: "tx.too_late", confirmed: true, must_not_fire: ["tx_bad_seq"] },
  "send-soroban-invalid": { top_cause: "tx_malformed", error_id: "tx.malformed", confirmed: true },
  "onchain-payment-underfunded": {
    top_cause: "payment_underfunded",
    error_id: "op.payment.underfunded",
    confirmed: true,
  },
  "onchain-footprint-miss": {
    top_cause: "footprint_access_outside_declared",
    error_id: "soroban.host.storage.exceeded_limit",
    confirmed: true,
    must_not_fire: ["entry_archived", "contract_not_deployed"],
  },
  "onchain-insufficient-refundable-fee": {
    top_cause: "insufficient_refundable_fee",
    error_id: "op.invoke_host_function.insufficient_refundable_fee",
    confirmed: true,
  },
  "sim-contract-error-3": {
    top_cause: "contract_error_resolved",
    error_id: "soroban.contract.error",
    contract_error_name: "DeadlinePassed",
    confirmed: true,
  },
  "sim-missing-function": {
    top_cause: "function_not_found",
    error_id: "soroban.host.wasm_vm.missing_value",
    confirmed: true,
    must_not_fire: ["contract_not_deployed"],
  },
  "sim-bad-arg-type": {
    // Deterministic limitation: arg-type mismatch is indistinguishable from a
    // contract panic at the host layer (see FINDINGS).
    top_cause: "contract_panicked",
    error_id: "soroban.host.wasm_vm.invalid_action",
    confirmed: true,
  },
  "sim-missing-contract": {
    top_cause: "contract_not_deployed",
    error_id: "soroban.host.storage.missing_value",
    confirmed: true,
    must_not_fire: ["function_not_found"],
  },
  "sim-budget-exceeded": {
    top_cause: "budget_exceeded_in_simulation",
    error_id: "soroban.host.budget.exceeded_limit",
    confirmed: true,
    must_not_fire: ["budget_exceeded_declared_too_low"],
  },
  "sim-sac-missing-trustline": {
    top_cause: "sac_trustline_missing",
    error_id: "soroban.contract.error",
    contract_error_name: "TrustlineMissingError",
    confirmed: true,
  },
  "sim-unwrap-none": {
    top_cause: "contract_panicked",
    error_id: "soroban.host.wasm_vm.invalid_action",
    confirmed: true,
  },
  "onchain-fee-bump-inner-failed": {
    top_cause: "contract_error_resolved",
    error_id: "soroban.contract.error",
    contract_error_name: "Unauthorized",
    confirmed: true,
  },
  "onchain-sac-balance-real": {
    top_cause: "sac_balance_insufficient",
    error_id: "soroban.contract.error",
    contract_error_name: "BalanceError",
    confirmed: true,
    must_not_fire: ["sac_trustline_missing", "auth_invocation_mismatch"],
  },
  "sim-temp-entry-expired": {
    top_cause: "contract_panicked",
    error_id: "soroban.host.wasm_vm.invalid_action",
    confirmed: true,
  },
};

interface ManifestEntry {
  name: string;
  kind: "tx" | "send_error" | "sim";
  network?: string;
  hash?: string;
  sendResponse?: { errorResultXdr?: string };
  simRequestXdr?: string;
  simResponse?: unknown;
  notes?: string;
  error?: string;
  skipped?: string;
}

async function record(
  name: string,
  network: "testnet" | "mainnet",
  input: DiagnoseInput,
  notes: string | undefined,
  label: (typeof LABELS)[string] | null,
) {
  const recorder = new RecordingTransport(new HttpTransport(NETWORK_RPC[network]!));
  const envelope = await diagnose(input, { network, transport: recorder });
  const fixture = {
    name,
    description: notes ?? "",
    network,
    input,
    expected: label
      ? {
          error_id: label.error_id,
          top_cause: label.top_cause,
          contract_error_name: label.contract_error_name ?? null,
          confirmed: label.confirmed,
          must_not_fire: label.must_not_fire ?? [],
        }
      : null,
    recorded: recorder.recorded,
    // Snapshot for humans reading the fixture; tests re-derive via replay.
    observed: {
      error_id: envelope.error.id,
      top_cause: envelope.diagnoses[0]?.cause_id ?? null,
      diagnoses: envelope.diagnoses.map((d) => `${d.cause_id}@${d.confidence}${d.confirmed ? "+" : "-"}`),
    },
  };
  const path = join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 1));
  const match = label && envelope.diagnoses[0]?.cause_id === label.top_cause ? "LABEL-MATCH" : label ? "LABEL-MISMATCH!" : "unlabeled";
  console.log(`${name}: ${envelope.error.id ?? "-"} -> ${envelope.diagnoses[0]?.cause_id ?? "(none)"} [${match}] (${recorder.recorded.length} rpc calls)`);
}

// 1. Testnet manifests
for (const manifestPath of process.argv.slice(2).filter((p) => p.endsWith(".json") && !p.includes("mainnet"))) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
  for (const entry of manifest) {
    if (entry.error || entry.skipped) continue;
    let input: DiagnoseInput;
    if (entry.kind === "tx" && entry.hash) input = { kind: "tx_hash", hash: entry.hash };
    else if (entry.kind === "send_error" && entry.sendResponse?.errorResultXdr)
      input = { kind: "xdr", base64: entry.sendResponse.errorResultXdr };
    else if (entry.kind === "sim" && entry.simResponse)
      input = {
        kind: "simulation",
        response: entry.simResponse,
        request_xdr: entry.simRequestXdr,
        ref: entry.name,
      };
    else continue;
    try {
      await record(entry.name, "testnet", input, entry.notes, LABELS[entry.name] ?? null);
    } catch (e) {
      console.log(`${entry.name}: RECORD FAILED ${(e as Error).message}`);
    }
  }
}

// 2. Wild mainnet captures (unlabeled coverage fixtures)
for (const scanPath of process.argv.slice(2).filter((p) => p.includes("mainnet"))) {
  const scan = JSON.parse(readFileSync(scanPath, "utf8")) as {
    hits: Array<{ hash: string; ledger: number; opCodes: string[] }>;
  };
  let i = 0;
  const perCode: Record<string, number> = {};
  for (const hit of scan.hits) {
    const code = hit.opCodes[0] ?? "unknown";
    perCode[code] = (perCode[code] ?? 0) + 1;
    if (perCode[code]! > 5) continue; // cap per op code
    const name = `mainnet-wild-${code.replace(/invokeHostFunction/i, "").toLowerCase()}-${++i}`;
    if (existsSync(join(FIXTURE_DIR, `${name}.json`))) continue;
    try {
      await record(name, "mainnet", { kind: "tx_hash", hash: hit.hash }, `wild mainnet failure @ ledger ${hit.ledger}`, null);
    } catch (e) {
      console.log(`${name}: RECORD FAILED ${(e as Error).message}`);
    }
  }
}

console.log("done");
