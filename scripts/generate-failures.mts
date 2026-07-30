/**
 * DEV-ONLY fixture source generator. NOT part of the shipped tool.
 *
 * soroban-diagnose itself never signs or submits transactions. This script is
 * the test-corpus factory: it deliberately produces real failures on TESTNET
 * (on-chain failures, submission rejections, and failed simulations) and
 * writes a manifest that scripts/record-fixtures.mts later turns into offline
 * replay fixtures.
 *
 * Techniques:
 *  - arg-swap: simulate a benign variant of a call, then submit the failing
 *    variant with the benign variant's sorobanData, so the tx passes
 *    validation and fails during apply (which is what real users hit).
 *  - resource-patch: shrink declared resources below what execution needs.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc as SdkRpc,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const server = new SdkRpc.Server(RPC_URL);
const PASSPHRASE = Networks.TESTNET;

const envPath = process.argv[2];
const manifestPath = process.argv[3];
if (!envPath || !manifestPath) {
  console.error("usage: generate-failures.mts <chaos-env.json> <manifest-out.json>");
  process.exit(1);
}
const env = JSON.parse(readFileSync(envPath, "utf8")) as {
  admin: string;
  issuer: string;
  user: string;
  user2: string;
  chaos_id: string;
  sac_id: string;
};

function secret(name: string): string {
  return execSync(`stellar keys show ${name}`, { encoding: "utf8" }).trim();
}
const admin = Keypair.fromSecret(secret("chaos-admin"));
const issuer = Keypair.fromSecret(secret("chaos-issuer"));
const user = Keypair.fromSecret(secret("chaos-user"));
const user2 = Keypair.fromSecret(secret("chaos-user2"));

interface ManifestEntry {
  name: string;
  kind: "tx" | "send_error" | "sim";
  network: "testnet";
  hash?: string;
  sendResponse?: unknown;
  simRequestXdr?: string;
  simResponse?: unknown;
  expected: string; // expected cause_id or error signature — the label
  notes?: string;
  error?: string; // generator-side failure
}
const manifest: ManifestEntry[] = [];
function save() {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function buildInvoke(
  source: Keypair,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  opts: { fee?: string; timeout?: number } = {},
): Promise<Transaction> {
  const acct = await server.getAccount(source.publicKey());
  return new TransactionBuilder(acct, {
    fee: opts.fee ?? BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(opts.timeout ?? 300)
    .build();
}

async function assemble(tx: Transaction): Promise<Transaction> {
  const sim = await server.simulateTransaction(tx);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`benign simulation failed: ${(sim as { error?: string }).error}`);
  }
  return SdkRpc.assembleTransaction(tx, sim).build();
}

/** Swap the invoke args of an already-assembled tx and re-wrap for signing. */
function swapInvokeArgs(tx: Transaction, newArgs: xdr.ScVal[], newFn?: string): Transaction {
  const envXdr = tx.toEnvelope();
  const op = envXdr.v1().tx().operations()[0]!.body().invokeHostFunctionOp();
  const invoke = op.hostFunction().invokeContract();
  invoke.args(newArgs);
  if (newFn) invoke.functionName(newFn);
  return new Transaction(envXdr, PASSPHRASE);
}

function patchResources(
  tx: Transaction,
  patch: { instructions?: number; writeBytes?: number; resourceFee?: bigint },
): Transaction {
  const envXdr = tx.toEnvelope();
  const sd = envXdr.v1().tx().ext().sorobanData();
  if (patch.instructions !== undefined) sd.resources().instructions(patch.instructions);
  if (patch.writeBytes !== undefined) sd.resources().writeBytes(patch.writeBytes);
  if (patch.resourceFee !== undefined) sd.resourceFee(xdr.Int64.fromString(patch.resourceFee.toString()));
  return new Transaction(envXdr, PASSPHRASE);
}

async function submitAndPoll(tx: Transaction, signer: Keypair): Promise<{ hash: string; status: string } | { sendResponse: unknown }> {
  tx.sign(signer);
  const send = await server.sendTransaction(tx);
  if (send.status === "ERROR") {
    return {
      sendResponse: {
        status: send.status,
        hash: send.hash,
        errorResultXdr: send.errorResult?.toXDR("base64"),
        diagnosticEventsXdr: (send as { diagnosticEvents?: xdr.DiagnosticEvent[] }).diagnosticEvents?.map(
          (e) => e.toXDR("base64"),
        ),
      },
    };
  }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const got = await server.getTransaction(send.hash);
    if (got.status !== "NOT_FOUND") {
      return { hash: send.hash, status: got.status };
    }
  }
  throw new Error(`tx ${send.hash} never left NOT_FOUND`);
}

async function scenario(name: string, expected: string, notes: string, fn: () => Promise<Partial<ManifestEntry>>) {
  process.stdout.write(`\n=== ${name} ... `);
  try {
    const extra = await fn();
    manifest.push({ name, kind: "tx", network: "testnet", expected, notes, ...extra });
    console.log(`ok (${JSON.stringify(extra).slice(0, 120)})`);
  } catch (e) {
    manifest.push({ name, kind: "tx", network: "testnet", expected, notes, error: (e as Error).message });
    console.log(`GENERATOR FAILED: ${(e as Error).message}`);
  }
  save();
}

/** Record a deliberately failing simulation. */
async function simScenario(name: string, expected: string, notes: string, mkTx: () => Promise<Transaction>) {
  await scenario(name, expected, notes, async () => {
    const tx = await mkTx();
    const raw = (await server._simulateTransaction(tx)) as unknown;
    return { kind: "sim", simRequestXdr: tx.toXDR(), simResponse: raw };
  });
}

const chaos = env.chaos_id;
const sac = env.sac_id;

/* ------------------------------------------------------------------ */

// 1. On-chain contract error #1 via arg swap (fail_with(0) is benign).
await scenario("onchain-contract-error-1", "contract.custom_error", "arg-swap fail_with(0)->fail_with(1)", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]));
  const failing = swapInvokeArgs(benign, [nativeToScVal(1, { type: "u32" })]);
  return await submitAndPoll(failing, admin);
});

// 2. On-chain contract error #7.
await scenario("onchain-contract-error-7", "contract.custom_error", "arg-swap fail_with(0)->fail_with(7)", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]));
  const failing = swapInvokeArgs(benign, [nativeToScVal(7, { type: "u32" })]);
  return await submitAndPoll(failing, admin);
});

// 3. On-chain plain wasm panic (borrowed sorobanData from fail_with(0)).
await scenario("onchain-wasm-panic", "host.wasm_trap", "fn-swap fail_with(0)->boom()", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]));
  const failing = swapInvokeArgs(benign, [], "boom");
  return await submitAndPoll(failing, admin);
});

// 4. On-chain budget exhaustion: spin(400000) with spin(1)'s declared resources.
await scenario("onchain-budget-exceeded", "host.budget_exceeded", "arg-swap spin(1)->spin(400000)", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "spin", [nativeToScVal(1, { type: "u32" })]));
  const failing = swapInvokeArgs(benign, [nativeToScVal(400000, { type: "u32" })]);
  return await submitAndPoll(failing, admin);
});

// 5. On-chain SAC insufficient balance: user has 100 CHAOS, sends 50 (benign sim) -> swap to 5000.
await scenario("onchain-sac-balance", "sac.balance_below_amount", "amount-swap transfer 50->5000 CHAOS to issuer", async () => {
  const args = (amount: bigint) => [
    nativeToScVal(new Address(user.publicKey()), { type: "address" }),
    nativeToScVal(new Address(issuer.publicKey()), { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
  ];
  const benign = await buildInvoke(user, sac, "transfer", args(50_0000000n));
  const sim = await server.simulateTransaction(benign);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`sim: ${(sim as { error?: string }).error}`);
  const assembled = SdkRpc.assembleTransaction(benign, sim).build();
  const failing = swapInvokeArgs(assembled, args(5000_0000000n));
  // transfer requires user auth; recording-mode sim returned a source-account credential
  // (source is the user), so re-signing the envelope is sufficient.
  return await submitAndPoll(failing, user);
});

// 6. On-chain SAC missing trustline: create user2 trustline, simulate, remove it, submit.
await scenario("onchain-sac-missing-trustline", "sac.trustline_missing", "trustline created, simmed, deleted, then submitted", async () => {
  const asset = new Asset("CHAOS", issuer.publicKey());
  // create trustline
  const a1 = await server.getAccount(user2.publicKey());
  const t1 = new TransactionBuilder(a1, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(120)
    .build();
  const r1 = await submitAndPoll(t1, user2);
  if (!("hash" in r1) || r1.status !== "SUCCESS") throw new Error("changeTrust create failed");
  // benign sim: user -> user2 transfer while trustline exists
  const args = [
    nativeToScVal(new Address(user.publicKey()), { type: "address" }),
    nativeToScVal(new Address(user2.publicKey()), { type: "address" }),
    nativeToScVal(10_0000000n, { type: "i128" }),
  ];
  const benign = await buildInvoke(user, sac, "transfer", args);
  const sim = await server.simulateTransaction(benign);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`sim: ${(sim as { error?: string }).error}`);
  const assembled = SdkRpc.assembleTransaction(benign, sim).build();
  // delete trustline (balance is 0)
  const a2 = await server.getAccount(user2.publicKey());
  const t2 = new TransactionBuilder(a2, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset, limit: "0" }))
    .setTimeout(120)
    .build();
  const r2 = await submitAndPoll(t2, user2);
  if (!("hash" in r2) || r2.status !== "SUCCESS") throw new Error("changeTrust delete failed");
  // submit the now-stale transfer
  return await submitAndPoll(assembled, user);
});

// 7. On-chain auth failure: guarded(user2) submitted with user2's auth entry unsigned.
await scenario("onchain-auth-unsigned", "auth.entry_not_signed", "sim returns address credentials; submitted without signing them", async () => {
  const tx = await buildInvoke(admin, chaos, "guarded", [
    nativeToScVal(new Address(user2.publicKey()), { type: "address" }),
  ]);
  const sim = await server.simulateTransaction(tx);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`sim: ${(sim as { error?: string }).error}`);
  const assembled = SdkRpc.assembleTransaction(tx, sim).build();
  return await submitAndPoll(assembled, admin);
});

// 8. On-chain auth expired: sign user2's auth entry valid only ~3 ledgers, wait, submit.
await scenario("onchain-auth-expired", "auth.signature_expired", "authorizeEntry validUntil=+3 ledgers, waited 40s", async () => {
  const tx = await buildInvoke(admin, chaos, "guarded", [
    nativeToScVal(new Address(user2.publicKey()), { type: "address" }),
  ]);
  const sim = await server.simulateTransaction(tx);
  if (!SdkRpc.Api.isSimulationSuccess(sim)) throw new Error(`sim: ${(sim as { error?: string }).error}`);
  const latest = await server.getLatestLedger();
  const entries = sim.result!.auth ?? [];
  const signed = await Promise.all(
    entries.map((e) => authorizeEntry(e, user2, latest.sequence + 3, PASSPHRASE)),
  );
  const acct = await server.getAccount(admin.publicKey());
  const rebuilt = new TransactionBuilder(acct, { fee: (Number(BASE_FEE) * 2).toString(), networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: chaos,
        function: "guarded",
        args: [nativeToScVal(new Address(user2.publicKey()), { type: "address" })],
        auth: signed,
      }),
    )
    .setTimeout(300)
    .build();
  const sim2 = await server.simulateTransaction(rebuilt);
  if (!SdkRpc.Api.isSimulationSuccess(sim2)) throw new Error(`sim2: ${(sim2 as { error?: string }).error}`);
  const assembled = SdkRpc.assembleTransaction(rebuilt, sim2).build();
  await sleep(40_000); // let the signature expire
  return await submitAndPoll(assembled, admin);
});

// 9. Submission rejection: bad sequence number.
await scenario("send-bad-seq", "tx.bad_seq", "sequence number +100", async () => {
  const acct = await server.getAccount(admin.publicKey());
  const bumped = new Account(admin.publicKey(), (BigInt(acct.sequenceNumber()) + 100n).toString());
  const tx = new TransactionBuilder(bumped, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: env.user, asset: Asset.native(), amount: "1" }))
    .setTimeout(120)
    .build();
  const res = await submitAndPoll(tx, admin);
  if (!("sendResponse" in res)) throw new Error("expected ERROR from sendTransaction");
  return { kind: "send_error", ...res };
});

// 10. Submission rejection: insufficient fee.
await scenario("send-insufficient-fee", "tx.insufficient_fee", "fee of 50 stroops", async () => {
  const acct = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "50", networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: env.user, asset: Asset.native(), amount: "1" }))
    .setTimeout(120)
    .build();
  const res = await submitAndPoll(tx, admin);
  if (!("sendResponse" in res)) throw new Error("expected ERROR from sendTransaction");
  return { kind: "send_error", ...res };
});

// 11. Submission rejection: expired timebounds.
await scenario("send-too-late", "tx.too_late", "maxTime 120s in the past", async () => {
  const acct = await server.getAccount(admin.publicKey());
  const now = Math.floor(Date.now() / 1000);
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: env.user, asset: Asset.native(), amount: "1" }))
    .setTimebounds(0, now - 120)
    .build();
  const res = await submitAndPoll(tx, admin);
  if (!("sendResponse" in res)) throw new Error("expected ERROR from sendTransaction");
  return { kind: "send_error", ...res };
});

// 12. Submission rejection: soroban invoke without sorobanData.
await scenario("send-soroban-invalid", "tx.soroban_invalid", "invoke submitted without simulation/sorobanData", async () => {
  const tx = await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]);
  const res = await submitAndPoll(tx, admin);
  if (!("sendResponse" in res)) throw new Error("expected ERROR from sendTransaction");
  return { kind: "send_error", ...res };
});

// 13. On-chain classic op failure: XLM payment far beyond balance.
await scenario("onchain-payment-underfunded", "op.payment.underfunded", "user2 sends 1M XLM", async () => {
  const acct = await server.getAccount(user2.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(Operation.payment({ destination: env.user, asset: Asset.native(), amount: "1000000" }))
    .setTimeout(120)
    .build();
  return await submitAndPoll(tx, user2);
});

// 14. On-chain footprint miss: sim fail_with(0), submit call_missing(random contract).
await scenario("onchain-footprint-miss", "storage.outside_footprint", "call_missing with footprint from fail_with(0)", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]));
  const randomContract = Keypair.random().rawPublicKey();
  const target = Address.contract(randomContract);
  const failing = swapInvokeArgs(
    benign,
    [nativeToScVal(target, { type: "address" })],
    "call_missing",
  );
  return await submitAndPoll(failing, admin);
});

// 15. On-chain insufficient refundable fee: shrink resourceFee on a tx that emits events.
await scenario("onchain-insufficient-refundable-fee", "fee.refundable_insufficient", "resourceFee patched down on event_then_fail... actually fill(1)", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fill", [nativeToScVal(1, { type: "u32" })]));
  const sd = benign.toEnvelope().v1().tx().ext().sorobanData();
  const declared = BigInt(sd.resourceFee().toString());
  // keep ~40% of the declared resource fee: enough to pass validation of
  // the non-refundable portion on most fills, not enough for the refundable part.
  const failing = patchResources(benign, { resourceFee: declared * 2n / 5n });
  return await submitAndPoll(failing, admin);
});

/* ---------------- simulation failures (recorded, not submitted) ----- */

await simScenario("sim-contract-error-3", "contract.custom_error", "fail_with(3) simulation", () =>
  buildInvoke(admin, chaos, "fail_with", [nativeToScVal(3, { type: "u32" })]),
);

await simScenario("sim-missing-function", "context.missing_function", "invoke nonexistent export", () =>
  buildInvoke(admin, chaos, "does_not_exist", []),
);

await simScenario("sim-bad-arg-type", "value.unexpected_type", "fail_with(string) instead of u32", () =>
  buildInvoke(admin, chaos, "fail_with", [nativeToScVal("notanumber", { type: "string" })]),
);

await simScenario("sim-missing-contract", "storage.missing_contract", "invoke a contract id that does not exist", async () => {
  const missing = Address.contract(Keypair.random().rawPublicKey()).toString();
  return buildInvoke(admin, missing, "whatever", []);
});

await simScenario("sim-budget-exceeded", "host.budget_exceeded", "spin(10000000) blows the tx instruction cap in simulation", () =>
  buildInvoke(admin, chaos, "spin", [nativeToScVal(10_000_000, { type: "u32" })]),
);

await simScenario("sim-sac-missing-trustline", "sac.trustline_missing", "transfer to user2 who has no trustline", () =>
  buildInvoke(user, sac, "transfer", [
    nativeToScVal(new Address(user.publicKey()), { type: "address" }),
    nativeToScVal(new Address(user2.publicKey()), { type: "address" }),
    nativeToScVal(10_0000000n, { type: "i128" }),
  ]),
);

await simScenario("sim-unwrap-none", "wasm.unwrap_panic", "read_missing: unwrap on absent storage key", () =>
  buildInvoke(admin, chaos, "read_missing", []),
);

// 16. Fee-bump wrapping a failing inner tx.
await scenario("onchain-fee-bump-inner-failed", "contract.custom_error", "fee bump around fail_with(2) arg-swap", async () => {
  const benign = await assemble(await buildInvoke(admin, chaos, "fail_with", [nativeToScVal(0, { type: "u32" })]));
  const failing = swapInvokeArgs(benign, [nativeToScVal(2, { type: "u32" })]);
  failing.sign(admin);
  const bump = TransactionBuilder.buildFeeBumpTransaction(issuer, (Number(BASE_FEE) * 100).toString(), failing, PASSPHRASE);
  bump.sign(issuer);
  const send = await server.sendTransaction(bump);
  if (send.status === "ERROR") {
    return {
      kind: "send_error" as const,
      sendResponse: { status: send.status, hash: send.hash, errorResultXdr: send.errorResult?.toXDR("base64") },
    };
  }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const got = await server.getTransaction(send.hash);
    if (got.status !== "NOT_FOUND") return { hash: send.hash, status: got.status };
  }
  throw new Error("fee bump never confirmed");
});

save();
console.log(`\nManifest written to ${manifestPath}: ${manifest.length} entries, ${manifest.filter((m) => m.error).length} generator failures`);
