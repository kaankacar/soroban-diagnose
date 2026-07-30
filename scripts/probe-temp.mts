/** DEV-ONLY: check the chaos contract's temp entry TTL state and what a read of it simulates to. */
import { readFileSync } from "node:fs";
import { Account, Address, BASE_FEE, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

const RPC = "https://soroban-testnet.stellar.org";
async function rpc(method: string, params: unknown): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const env = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const chaos: string = env.chaos_id;

const tempKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(chaos).toScAddress(),
    key: xdr.ScVal.scvSymbol("tmp"),
    durability: xdr.ContractDataDurability.temporary(),
  }),
).toXDR("base64");
const persKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(chaos).toScAddress(),
    key: xdr.ScVal.scvSymbol("mykey"),
    durability: xdr.ContractDataDurability.persistent(),
  }),
).toXDR("base64");

const latest = await rpc("getLatestLedger", undefined);
const res = await rpc("getLedgerEntries", { keys: [tempKey, persKey] });
console.log("latest ledger:", latest.sequence);
for (const e of res.entries ?? []) {
  console.log(e.key === tempKey ? "TEMP" : "PERS", "liveUntil:", e.liveUntilLedgerSeq, "expired:", e.liveUntilLedgerSeq < latest.sequence);
}
if ((res.entries ?? []).length < 2) console.log("some entries ABSENT:", 2 - (res.entries ?? []).length);

// simulate get_temp
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.invokeContractFunction({ contract: chaos, function: "get_temp", args: [] }))
  .setTimeout(60)
  .build();
const sim = await rpc("simulateTransaction", { transaction: tx.toXDR() });
console.log("get_temp sim keys:", Object.keys(sim).join(","));
console.log("get_temp sim error:", (sim.error ?? "<none>").slice(0, 400));
