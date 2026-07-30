/**
 * DEV-ONLY corpus scanner. Pages through recent mainnet ledgers via RPC
 * getTransactions, tallies failure codes (taxonomy-lite), and captures full
 * records of interesting Soroban failures for fixture recording.
 * Read-only: never signs or submits anything.
 */

import { writeFileSync } from "node:fs";
import { xdr } from "@stellar/stellar-sdk";

const RPC = "https://mainnet.sorobanrpc.com";
const outPath = process.argv[2] ?? "mainnet-scan.json";
const maxPages = Number(process.argv[3] ?? 400);
const backLedgers = Number(process.argv[4] ?? 15000);
const onlyCodes = process.argv[5] ? new Set(process.argv[5].split(",")) : null;

let rpcId = 0;
async function call(method: string, params: unknown): Promise<any> {
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

const tally: Record<string, number> = {};
interface Hit {
  hash: string;
  ledger: number;
  txCode: string;
  opCodes: string[];
  record: unknown;
}
const hits: Hit[] = [];
const WANT = new Set([
  "invokeHostFunctionEntryArchived",
  "invokeHostFunctionResourceLimitExceeded",
  "invokeHostFunctionInsufficientRefundableFee",
  "invokeHostFunctionTrapped",
  "invokeHostFunctionMalformed",
  "extendFootprintTtlMalformed",
  "restoreFootprintMalformed",
]);
const capPerCode: Record<string, number> = {
  invokeHostFunctionTrapped: 12,
  invokeHostFunctionEntryArchived: 8,
  invokeHostFunctionResourceLimitExceeded: 8,
  invokeHostFunctionInsufficientRefundableFee: 8,
  invokeHostFunctionMalformed: 4,
};
const captured: Record<string, number> = {};

function opCodesOf(resultXdrB64: string): { txCode: string; opCodes: string[] } {
  const tr = xdr.TransactionResult.fromXDR(resultXdrB64, "base64");
  let result = tr.result();
  let txCode = result.switch().name;
  let results = [];
  try {
    if (txCode === "txFeeBumpInnerFailed" || txCode === "txFeeBumpInnerSuccess") {
      const inner = result.innerResultPair().result();
      txCode = `${txCode}>${inner.result().switch().name}`;
      results = inner.result().results ? inner.result().results() : [];
    } else {
      results = result.results ? result.results() : [];
    }
  } catch {
    results = [];
  }
  const opCodes: string[] = [];
  for (const op of results ?? []) {
    if (op.switch().name !== "opInner") {
      opCodes.push(op.switch().name);
      continue;
    }
    const trv = op.tr();
    const val = trv.value() as { switch?: () => { name: string } };
    opCodes.push(val && val.switch ? val.switch().name : trv.switch().name);
  }
  return { txCode, opCodes };
}

const latest = await call("getLatestLedger", undefined);
console.log("latest mainnet ledger:", latest.sequence);
let cursor: string | undefined;
let startLedger: number | undefined = latest.sequence - backLedgers;
let pages = 0;
let scanned = 0;
let failed = 0;

while (pages < maxPages) {
  pages++;
  let res;
  try {
    res = await call("getTransactions", {
      ...(cursor ? { pagination: { cursor, limit: 200 } } : { startLedger, pagination: { limit: 200 } }),
    });
  } catch (e) {
    console.error("page error:", (e as Error).message);
    break;
  }
  for (const tx of res.transactions ?? []) {
    scanned++;
    if (tx.status !== "FAILED") continue;
    failed++;
    try {
      const { txCode, opCodes } = opCodesOf(tx.resultXdr);
      const key = [txCode, ...opCodes].join("|");
      tally[key] = (tally[key] ?? 0) + 1;
      const interesting = opCodes.find((c) => (onlyCodes ? onlyCodes.has(c) : WANT.has(c)));
      if (interesting) {
        const cap = capPerCode[interesting] ?? 6;
        if ((captured[interesting] ?? 0) < cap) {
          captured[interesting] = (captured[interesting] ?? 0) + 1;
          hits.push({ hash: tx.txHash, ledger: tx.ledger, txCode, opCodes, record: tx });
        }
      }
    } catch {
      tally["<undecodable>"] = (tally["<undecodable>"] ?? 0) + 1;
    }
  }
  cursor = res.cursor;
  if (!cursor || (res.transactions ?? []).length === 0) break;
  if (pages % 25 === 0) {
    console.log(`page ${pages}: scanned=${scanned} failed=${failed} hits=${hits.length}`);
    writeFileSync(outPath, JSON.stringify({ scanned, failed, tally, hits }, null, 1));
  }
}

writeFileSync(outPath, JSON.stringify({ scanned, failed, tally, hits }, null, 1));
console.log(`done: scanned=${scanned} failed=${failed} hits=${hits.length}`);
console.log("tally:", JSON.stringify(tally, null, 1));
