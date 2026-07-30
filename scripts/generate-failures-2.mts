/**
 * DEV-ONLY, TESTNET-ONLY. Round 2 of failure generation:
 *  - real on-chain SAC BalanceError: simulate a transfer while funded, drain
 *    the balance with a second transfer, then submit the original (args and
 *    auth untouched — the textbook state-changed-under-you failure).
 *  - temp-entry expiry read (once the entry's TTL has lapsed).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc as SdkRpc,
  xdr,
} from "@stellar/stellar-sdk";

const server = new SdkRpc.Server("https://soroban-testnet.stellar.org");
const PASSPHRASE = Networks.TESTNET;

const env = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const outPath = process.argv[3]!;
const results: unknown[] = [];

function secret(name: string): string {
  return execSync(`stellar keys show ${name}`, { encoding: "utf8" }).trim();
}
const user = Keypair.fromSecret(secret("chaos-user"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submit(tx: Transaction, signer: Keypair): Promise<{ hash: string; status: string }> {
  tx.sign(signer);
  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") throw new Error(`send error: ${send.errorResult?.toXDR("base64")}`);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const got = await server.getTransaction(send.hash);
    if (got.status !== "NOT_FOUND") return { hash: send.hash, status: got.status };
  }
  throw new Error("timeout");
}

async function buildTransfer(amount: bigint): Promise<Transaction> {
  const acct = await server.getAccount(user.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: env.sac_id,
        function: "transfer",
        args: [
          nativeToScVal(new Address(user.publicKey()), { type: "address" }),
          nativeToScVal(new Address(env.issuer), { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
        ],
      }),
    )
    .setTimeout(600)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`sim failed: ${(sim as { error?: string }).error}`);
  return SdkRpc.assembleTransaction(tx, sim).build();
}

// --- Scenario A: state changes between simulation and submission ----------
// Build the drain at seq N and the victim at seq N+1 while the balance is
// still intact; submit drain first, then the victim lands underfunded with
// args and auth untouched.
try {
  const drain = await buildTransfer(30_0000000n); // seq N — will empty most of the balance
  const victim = await (async () => {
    // build at seq N+1 while balance is still intact
    const acct = await server.getAccount(user.publicKey());
    const nextSeq = (BigInt(acct.sequenceNumber()) + 1n).toString();
    const acctNext = new (await import("@stellar/stellar-sdk")).Account(user.publicKey(), nextSeq);
    const tx = new TransactionBuilder(acctNext, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.invokeContractFunction({
          contract: env.sac_id,
          function: "transfer",
          args: [
            nativeToScVal(new Address(user.publicKey()), { type: "address" }),
            nativeToScVal(new Address(env.issuer), { type: "address" }),
            nativeToScVal(30_0000000n, { type: "i128" }),
          ],
        }),
      )
      .setTimeout(600)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`victim sim failed: ${(sim as { error?: string }).error}`);
    return SdkRpc.assembleTransaction(tx, sim).build();
  })();

  const r1 = await submit(drain, user);
  console.log("drain:", r1.status, r1.hash);
  const r2 = await submit(victim, user);
  console.log("victim (expect FAILED BalanceError):", r2.status, r2.hash);
  results.push({ name: "onchain-sac-balance-real", kind: "tx", network: "testnet", hash: r2.hash, expected: "sac_balance_insufficient", notes: "balance drained between simulation and submission; args+auth untouched" });
} catch (e) {
  console.log("scenario A failed:", (e as Error).message);
  results.push({ name: "onchain-sac-balance-real", error: (e as Error).message });
}

// --- Scenario B: read an expired temporary entry ---------------------------
try {
  const tempKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(env.chaos_id).toScAddress(),
      key: xdr.ScVal.scvSymbol("tmp"),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  ).toXDR("base64");
  const latest = await server.getLatestLedger();
  const entries = await server.getLedgerEntries(xdr.LedgerKey.fromXDR(tempKey, "base64"));
  const live = entries.entries.length > 0 ? entries.entries[0]!.liveUntilLedgerSeq : null;
  console.log(`temp entry liveUntil=${live} latest=${latest.sequence}`);
  if (live && live > latest.sequence) {
    console.log(`temp entry still live for ${live - latest.sequence} ledgers — record sim anyway if expired later`);
    results.push({ name: "sim-temp-entry-expired", skipped: `still live until ${live}` });
  } else {
    // expired (or evicted): simulate get_temp — a real "temporary data vanished" failure
    const acct = await server.getAccount(user.publicKey());
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.invokeContractFunction({ contract: env.chaos_id, function: "get_temp", args: [] }))
      .setTimeout(300)
      .build();
    const sim = (await server._simulateTransaction(tx)) as unknown;
    results.push({ name: "sim-temp-entry-expired", kind: "sim", network: "testnet", simRequestXdr: tx.toXDR(), simResponse: sim, expected: "contract_panicked", notes: "temporary entry expired+evicted; contract unwrap panics" });
    console.log("recorded expired-temp simulation");
  }
} catch (e) {
  console.log("scenario B failed:", (e as Error).message);
  results.push({ name: "sim-temp-entry-expired", error: (e as Error).message });
}

writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`wrote ${outPath}`);
