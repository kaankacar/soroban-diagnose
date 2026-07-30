/**
 * DEV-ONLY. Find a mainnet contract whose persistent state (instance or data)
 * has expired, by sampling early-Soroban-era operations from Horizon full
 * history and checking TTLs via RPC. Then record a read-only simulation that
 * produces a real restorePreamble / archived-entry response.
 * Read-only: never signs or submits.
 */

import { writeFileSync } from "node:fs";
import {
  Account,
  Address,
  BASE_FEE,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon.stellar.org";
const RPC = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const outPath = process.argv[2] ?? "archived-hunt.json";
// Early Soroban mainnet era (protocol 20 activated ~ledger 50457424, Feb 2024).
const START_LEDGER = Number(process.argv[3] ?? 51_000_000);

let rpcId = 0;
async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

function instanceKey(contractId: string): string {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  ).toXDR("base64");
}

const latest = await rpc("getLatestLedger", undefined);
console.log("latest ledger:", latest.sequence);

// 1. Collect candidate contract ids from old operations.
const candidates = new Set<string>();
let cursor = (BigInt(START_LEDGER) << 32n).toString();
let pages = 0;
while (candidates.size < 120 && pages < 40) {
  pages++;
  const res = await fetch(
    `${HORIZON}/operations?limit=200&order=asc&cursor=${cursor}&include_failed=false`,
    { signal: AbortSignal.timeout(30000) },
  );
  const json = (await res.json()) as any;
  const records = json._embedded?.records ?? [];
  if (records.length === 0) break;
  for (const op of records) {
    if (op.type === "invoke_host_function") {
      for (const b of op.asset_balance_changes ?? []) void b;
      // The contract address shows up in parameters or via the tx; cheapest:
      // look at `function` + parse parameters for Address-typed values.
      if (op.parameters) {
        for (const p of op.parameters) {
          if (p.type === "Address" && typeof p.value === "string") {
            try {
              const sv = xdr.ScVal.fromXDR(p.value, "base64");
              if (sv.switch().name === "scvAddress" && sv.address().switch().name === "scAddressTypeContract") {
                candidates.add(Address.fromScAddress(sv.address()).toString());
              }
            } catch {
              /* skip */
            }
          }
        }
      }
    }
  }
  cursor = records[records.length - 1].paging_token;
}
console.log(`candidate contracts: ${candidates.size} (from ${pages} pages)`);

// 2. Check instance TTLs in batches; find expired-but-present or absent.
const ids = [...candidates];
const expired: { contract: string; liveUntil: number }[] = [];
const missing: string[] = [];
for (let i = 0; i < ids.length; i += 50) {
  const chunk = ids.slice(i, i + 50);
  const keys = chunk.map(instanceKey);
  const res = await rpc("getLedgerEntries", { keys });
  const found = new Map<string, any>();
  for (const e of res.entries ?? []) found.set(e.key, e);
  chunk.forEach((cid, j) => {
    const e = found.get(keys[j]!);
    if (!e) {
      missing.push(cid);
    } else if (e.liveUntilLedgerSeq && e.liveUntilLedgerSeq < latest.sequence) {
      expired.push({ contract: cid, liveUntil: e.liveUntilLedgerSeq });
    }
  });
}
console.log(`expired-instance contracts: ${expired.length}; missing (evicted or never existed): ${missing.length}`);

// 3. For each candidate (expired first, then missing — those may be evicted
//    to the hot archive), simulate a call and look for restorePreamble or an
//    archived-entry error.
const results: unknown[] = [];
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
for (const target of [...expired.map((e) => e.contract), ...missing.slice(0, 30)]) {
  const acct = new Account(NULL_ACCOUNT, "0");
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: process.env.PASSPHRASE === "testnet" ? Networks.TESTNET : Networks.PUBLIC })
    .addOperation(
      Operation.invokeContractFunction({ contract: target, function: "balance", args: [
        xdr.ScVal.scvAddress(new Address(NULL_ACCOUNT).toScAddress()),
      ] }),
    )
    .setTimeout(60)
    .build();
  try {
    const sim = await rpc("simulateTransaction", { transaction: tx.toXDR() });
    const hasPreamble = !!sim.restorePreamble;
    const err: string = sim.error ?? "";
    const archivedErr = /archiv|restore|expired/i.test(err);
    if (hasPreamble || archivedErr) {
      console.log(`HIT ${target}: preamble=${hasPreamble} err=${err.slice(0, 100)}`);
      results.push({ contract: target, simRequestXdr: tx.toXDR(), simResponse: sim });
      if (results.length >= 4) break;
    }
  } catch (e) {
    console.log(`sim error for ${target}: ${(e as Error).message.slice(0, 80)}`);
  }
}

writeFileSync(outPath, JSON.stringify({ latest: latest.sequence, expired, missingCount: missing.length, results }, null, 1));
console.log(`wrote ${outPath}: ${results.length} archived-entry simulations captured`);
