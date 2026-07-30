/**
 * State-lookup checks. Each check inspects ledger state (or envelope-derived
 * facts) and returns confirmed / refuted / unavailable plus evidence objects.
 * Every check that runs contributes evidence, whether it confirms or
 * eliminates — that is the contract with the consumer.
 *
 * All lookups run against diagnosis-time state. For on-chain failures that
 * happened in the past, state may have drifted since the failure; evidence
 * carries the ledger it was observed at so consumers can judge.
 */

import { xdr, Address, Asset, StrKey } from "@stellar/stellar-sdk";
import type { Envelope, Evidence } from "../types.js";
import type { RawFailure } from "../ingest.js";
import type { RpcSession } from "../rpc.js";
import type { RuleCheck } from "./ruleschema.js";
import { contractInstanceKey, decodeInstance } from "../decode/spec.js";
import { ledgerKeyView } from "../decode/txenvelope.js";
import { scValDisplay } from "../decode/scval.js";

export interface CheckContext {
  session: RpcSession | null;
  envelope: Envelope;
  raw: RawFailure;
  /** Interpolation bag; checks may add variables. */
  vars: Record<string, string>;
}

export interface CheckResult {
  outcome: "confirmed" | "refuted" | "unavailable";
  evidence: Evidence[];
}

const unavailable = (type: string, detail: string): CheckResult => ({
  outcome: "unavailable",
  evidence: [{ type, source: "n/a", outcome: "unavailable", detail }],
});

export async function runCheck(ctx: CheckContext, check: RuleCheck): Promise<CheckResult> {
  try {
    switch (check.kind) {
      case "ttl":
        return await ttlCheck(ctx, check);
      case "trustline":
        return await trustlineCheck(ctx, check);
      case "account":
        return await accountCheck(ctx, check);
      case "resource_headroom":
        return await resourceHeadroomCheck(ctx, check);
      case "auth_expiration":
        return authExpirationCheck(ctx, check);
      case "auth_signature":
        return authSignatureCheck(ctx, check);
      case "wasm_spec":
        return wasmSpecCheck(ctx, check);
      case "declared_resources":
        return declaredResourcesCheck(ctx, check);
      case "restore_preamble":
        return restorePreambleCheck(ctx, check);
      case "diagnostic_message":
        return diagnosticMessageCheck(ctx, check);
    }
  } catch (e) {
    return unavailable(check.kind, `check failed to run: ${(e as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* selectors                                                            */
/* ------------------------------------------------------------------ */

/** Resolve an address selector: "source" | "arg:N" | "var:name" | "diagnostic". */
function selectAddress(ctx: CheckContext, selector: string | undefined): string | null {
  if (!selector || selector === "source") {
    return ctx.envelope.transaction?.source_account ?? null;
  }
  const arg = /^arg:(\d+)$/.exec(selector);
  if (arg) {
    const v = ctx.envelope.transaction?.invocation?.args[Number(arg[1])];
    return typeof v === "string" && /^[GC][A-Z2-7]{55}$/.test(v) ? v : null;
  }
  const varRef = /^var:(\w+)$/.exec(selector);
  if (varRef) return ctx.vars[varRef[1]!] ?? null;
  if (selector === "diagnostic") {
    // First address mentioned in error-event args or messages, falling back
    // to the invoked contract.
    for (const e of ctx.raw.facts.errors) {
      for (const a of e.args) {
        if (typeof a === "string") {
          const m = /[GC][A-Z2-7]{55}/.exec(a);
          if (m) return m[0];
        }
      }
      if (e.message) {
        const m = /[GC][A-Z2-7]{55}/.exec(e.message);
        if (m) return m[0];
      }
    }
    if (ctx.raw.sim_error) {
      const m = /[GC][A-Z2-7]{55}/.exec(ctx.raw.sim_error);
      if (m) return m[0];
    }
    return ctx.envelope.transaction?.invocation?.contract_id ?? null;
  }
  if (/^[GC][A-Z2-7]{55}$/.test(selector)) return selector;
  return null;
}

function accountLedgerKey(g: string): string {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(g)),
    }),
  ).toXDR("base64");
}

/* ------------------------------------------------------------------ */
/* ttl                                                                  */
/* ------------------------------------------------------------------ */

async function ttlCheck(ctx: CheckContext, check: RuleCheck): Promise<CheckResult> {
  if (!ctx.session) return unavailable("ttl", "no RPC access for TTL lookups");
  const fp = ctx.envelope.transaction?.footprint;
  if (!fp) return unavailable("ttl", "the input carries no footprint to inspect");

  const target = check.target ?? "footprint.all";
  const keys =
    target === "footprint.read_only"
      ? fp.read_only
      : target === "footprint.read_write"
        ? fp.read_write
        : [...fp.read_only, ...fp.read_write];
  const stateKeys = keys.filter((k) => k.type === "contract_data" || k.type === "contract_code");
  if (stateKeys.length === 0) return unavailable("ttl", "footprint contains no contract state keys");

  const refLedger =
    ctx.envelope.transaction?.ledger ?? ctx.raw.latest_ledger ?? Number.MAX_SAFE_INTEGER;
  const found = await ctx.session.getLedgerEntries(stateKeys.map((k) => k.xdr));
  const latest = ctx.raw.latest_ledger;

  const evidence: Evidence[] = [];
  let expiredOrAbsent = 0;
  let live = 0;
  const CAP = 6;
  for (const k of stateKeys.slice(0, CAP)) {
    const e = found.get(k.xdr);
    if (!e) {
      expiredOrAbsent++;
      if (!ctx.vars.key) {
        ctx.vars.key = k.summary;
        ctx.vars.key_xdr = k.xdr;
        if (k.scval_xdr) ctx.vars.key_scval = k.scval_xdr;
        if (k.contract_id) ctx.vars.key_contract_id = k.contract_id;
        if (k.durability) ctx.vars.key_durability = k.durability;
      }
      evidence.push({
        type: "ttl",
        source: `rpc:getLedgerEntries@${latest ?? "?"}`,
        outcome: "confirmed",
        key: k.summary,
        observed: { present: false },
        detail: "Entry is absent from live state (evicted to the archive, or never created).",
      });
    } else if (e.liveUntilLedgerSeq !== undefined && e.liveUntilLedgerSeq < refLedger) {
      expiredOrAbsent++;
      ctx.vars.key = ctx.vars.key ?? k.summary;
      ctx.vars.key_xdr = ctx.vars.key_xdr ?? k.xdr;
      if (k.scval_xdr) ctx.vars.key_scval = ctx.vars.key_scval ?? k.scval_xdr;
      if (k.contract_id) ctx.vars.key_contract_id = ctx.vars.key_contract_id ?? k.contract_id;
      if (k.durability) ctx.vars.key_durability = ctx.vars.key_durability ?? k.durability;
      ctx.vars.live_until = String(e.liveUntilLedgerSeq);
      evidence.push({
        type: "ttl",
        source: `rpc:getLedgerEntries@${latest ?? "?"}`,
        outcome: "confirmed",
        key: k.summary,
        observed: { present: true, live_until_ledger: e.liveUntilLedgerSeq },
        expected: `live_until_ledger >= ${refLedger}`,
        detail: "Entry TTL has expired.",
      });
    } else {
      live++;
      evidence.push({
        type: "ttl",
        source: `rpc:getLedgerEntries@${latest ?? "?"}`,
        outcome: "info",
        key: k.summary,
        observed: { present: true, live_until_ledger: e.liveUntilLedgerSeq ?? null },
        detail:
          "Entry is live at diagnosis time. If the failure is old, it may have been restored since.",
      });
    }
  }
  if (stateKeys.length > CAP) {
    evidence.push({
      type: "ttl",
      source: "rpc:getLedgerEntries",
      outcome: "info",
      detail: `${stateKeys.length - CAP} further footprint keys not individually reported.`,
    });
  }
  ctx.vars.current_ledger = String(latest ?? "");

  const assert = check.assert ?? "expired";
  if (assert === "expired") {
    if (expiredOrAbsent > 0) return { outcome: "confirmed", evidence };
    if (live > 0) return { outcome: "refuted", evidence };
    return { outcome: "unavailable", evidence };
  }
  if (assert === "live") {
    if (expiredOrAbsent === 0 && live > 0) return { outcome: "confirmed", evidence };
    return { outcome: "refuted", evidence };
  }
  return unavailable("ttl", `unknown assert "${assert}"`);
}

/* ------------------------------------------------------------------ */
/* trustline                                                            */
/* ------------------------------------------------------------------ */

interface SacAsset {
  code: string;
  issuer: string | null; // null => native
  raw: string;
}

async function sacAssetOf(ctx: CheckContext, contractId: string): Promise<SacAsset | null> {
  if (!ctx.session) return null;
  const key = contractInstanceKey(contractId);
  const entries = await ctx.session.getLedgerEntries([key]);
  const entry = entries.get(key);
  if (!entry) return null;
  const inst = decodeInstance(entry.xdr);
  if (!inst || inst.executable !== "stellar_asset") return null;
  for (const val of inst.storage.values()) {
    try {
      const disp = scValDisplay(val);
      if (disp && typeof disp === "object" && "name" in (disp as Record<string, unknown>)) {
        const name = (disp as Record<string, unknown>).name;
        if (typeof name === "string") {
          if (name === "native") return { code: "XLM", issuer: null, raw: name };
          const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
          if (m) return { code: m[1]!, issuer: m[2]!, raw: name };
        }
      }
    } catch {
      /* next */
    }
  }
  return null;
}

function trustlineKey(account: string, asset: SacAsset): string {
  const xdrAsset = new Asset(asset.code, asset.issuer ?? undefined);
  const tlAsset =
    typeof (xdrAsset as unknown as { toTrustLineXDRObject?: () => unknown }).toTrustLineXDRObject ===
    "function"
      ? ((xdrAsset as unknown as { toTrustLineXDRObject: () => InstanceType<typeof xdr.TrustLineAsset> }).toTrustLineXDRObject())
      : buildTrustLineAsset(asset);
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(account)),
      asset: tlAsset,
    }),
  ).toXDR("base64");
}

function buildTrustLineAsset(asset: SacAsset): InstanceType<typeof xdr.TrustLineAsset> {
  const issuer = xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(asset.issuer!));
  if (asset.code.length <= 4) {
    return xdr.TrustLineAsset.assetTypeCreditAlphanum4(
      new xdr.AlphaNum4({ assetCode: Buffer.from(asset.code.padEnd(4, "\0")), issuer }),
    );
  }
  return xdr.TrustLineAsset.assetTypeCreditAlphanum12(
    new xdr.AlphaNum12({ assetCode: Buffer.from(asset.code.padEnd(12, "\0")), issuer }),
  );
}

async function trustlineCheck(ctx: CheckContext, check: RuleCheck): Promise<CheckResult> {
  if (!ctx.session) return unavailable("trustline", "no RPC access for trustline lookups");
  const account = selectAddress(ctx, check.target);
  if (!account) return unavailable("trustline", `could not resolve account from "${check.target}"`);
  if (account.startsWith("C")) {
    return unavailable(
      "trustline",
      `${account} is a contract address; its balance lives in contract storage, not a trustline`,
    );
  }
  const invokedContract =
    ctx.envelope.error.contract_error?.contract_id ??
    ctx.envelope.transaction?.invocation?.contract_id ??
    null;
  if (!invokedContract) return unavailable("trustline", "erroring contract unknown");
  const asset = await sacAssetOf(ctx, invokedContract);
  if (!asset) {
    return unavailable(
      "trustline",
      `${invokedContract} is not a Stellar Asset Contract (or its metadata is unreadable)`,
    );
  }
  ctx.vars.asset = asset.issuer ? `${asset.code}:${asset.issuer}` : "native";
  ctx.vars.account = account;

  if (!asset.issuer) {
    return unavailable("trustline", "native XLM has no trustlines; check the account instead");
  }
  if (account === asset.issuer) {
    return unavailable("trustline", "the account is the asset issuer; issuers hold no trustline");
  }

  const key = trustlineKey(account, asset);
  const latest = ctx.raw.latest_ledger;
  const entries = await ctx.session.getLedgerEntries([key]);
  const entry = entries.get(key);
  const source = `rpc:getLedgerEntries@${latest ?? "?"}`;

  const assert = check.assert ?? "missing";
  if (!entry) {
    const evidence: Evidence[] = [
      {
        type: "trustline",
        source,
        outcome: assert === "missing" ? "confirmed" : "refuted",
        key: `trustline ${ctx.vars.asset} of ${account}`,
        observed: { exists: false },
        detail: `${account} holds no ${asset.code} trustline at diagnosis time.`,
      },
    ];
    return { outcome: assert === "missing" ? "confirmed" : "refuted", evidence };
  }

  const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
  const tl = data.trustLine();
  const balance = BigInt(tl.balance().toString());
  const limit = BigInt(tl.limit().toString());
  const authorized = (tl.flags() & 1) === 1;
  const observed = {
    exists: true,
    balance: balance.toString(),
    limit: limit.toString(),
    authorized,
  };
  ctx.vars.balance = balance.toString();
  ctx.vars.limit = limit.toString();

  const ev = (outcome: Evidence["outcome"], detail: string): Evidence[] => [
    { type: "trustline", source, outcome, key: `trustline ${ctx.vars.asset} of ${account}`, observed, detail },
  ];

  switch (assert) {
    case "missing":
      return { outcome: "refuted", evidence: ev("refuted", "The trustline exists at diagnosis time.") };
    case "exists":
      return { outcome: "confirmed", evidence: ev("confirmed", "The trustline exists.") };
    case "deauthorized":
      return authorized
        ? { outcome: "refuted", evidence: ev("refuted", "The trustline is authorized.") }
        : { outcome: "confirmed", evidence: ev("confirmed", "The trustline is not authorized.") };
    case "balance_below_amount": {
      const amount = amountFromArgs(ctx);
      if (amount === null) return { outcome: "unavailable", evidence: ev("info", "Transfer amount could not be determined from the invocation args.") };
      ctx.vars.amount = amount.toString();
      return balance < amount
        ? {
            outcome: "confirmed",
            evidence: ev(
              "confirmed",
              `Balance ${balance} is below the attempted amount ${amount} (both in stroops-scale units).`,
            ),
          }
        : {
            outcome: "refuted",
            evidence: ev(
              "refuted",
              `Balance ${balance} covers the attempted amount ${amount} at diagnosis time; the balance may have changed since the failure.`,
            ),
          };
    }
    case "limit_exceeded": {
      const amount = amountFromArgs(ctx);
      if (amount === null) return { outcome: "unavailable", evidence: ev("info", "Transfer amount could not be determined.") };
      return balance + amount > limit
        ? { outcome: "confirmed", evidence: ev("confirmed", `Receiving ${amount} would exceed the trustline limit ${limit}.`) }
        : { outcome: "refuted", evidence: ev("refuted", `Trustline limit ${limit} has room for ${amount}.`) };
    }
    default:
      return unavailable("trustline", `unknown assert "${assert}"`);
  }
}

/** SAC transfer/burn amounts are the last i128 arg. */
function amountFromArgs(ctx: CheckContext): bigint | null {
  const args = ctx.envelope.transaction?.invocation?.args ?? [];
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (typeof a === "string" && /^-?\d+$/.test(a)) return BigInt(a);
    if (typeof a === "number" && Number.isInteger(a)) return BigInt(a);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* account                                                              */
/* ------------------------------------------------------------------ */

async function accountCheck(ctx: CheckContext, check: RuleCheck): Promise<CheckResult> {
  if (!ctx.session) return unavailable("account", "no RPC access for account lookups");
  const account = selectAddress(ctx, check.target);
  if (!account) {
    return unavailable("account", `could not resolve an address from "${check.target}"`);
  }
  if (account.startsWith("C")) return contractExistenceCheck(ctx, check, account);
  const key = accountLedgerKey(account);
  const latest = ctx.raw.latest_ledger;
  const entries = await ctx.session.getLedgerEntries([key]);
  const entry = entries.get(key);
  const source = `rpc:getLedgerEntries@${latest ?? "?"}`;
  const assert = check.assert ?? "missing";
  ctx.vars.account = account;

  if (!entry) {
    const outcome = assert === "missing" ? "confirmed" : "refuted";
    return {
      outcome,
      evidence: [
        {
          type: "account",
          source,
          outcome,
          key: `account ${account}`,
          observed: { exists: false },
          detail: `${account} does not exist on this network at diagnosis time.`,
        },
      ],
    };
  }
  const acc = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").account();
  const balance = BigInt(acc.balance().toString());
  ctx.vars.xlm_balance = balance.toString();
  const observed = { exists: true, xlm_balance_stroops: balance.toString(), sequence: acc.seqNum().toString() };
  const outcome = assert === "exists" ? "confirmed" : "refuted";
  return {
    outcome,
    evidence: [
      {
        type: "account",
        source,
        outcome,
        key: `account ${account}`,
        observed,
        detail: assert === "missing" ? "The account exists at diagnosis time." : "The account exists.",
      },
    ],
  };
}

/** Contract-address variant of the account check: instance existence. */
async function contractExistenceCheck(
  ctx: CheckContext,
  check: RuleCheck,
  contractId: string,
): Promise<CheckResult> {
  const key = contractInstanceKey(contractId);
  const latest = ctx.raw.latest_ledger;
  const entries = await ctx.session!.getLedgerEntries([key]);
  const entry = entries.get(key);
  const source = `rpc:getLedgerEntries@${latest ?? "?"}`;
  const assert = check.assert ?? "missing";
  ctx.vars.account = contractId;
  const exists = entry !== undefined;
  const outcome = (assert === "missing") !== exists ? "confirmed" : "refuted";
  return {
    outcome,
    evidence: [
      {
        type: "account",
        source,
        outcome,
        key: `contract instance ${contractId}`,
        observed: { exists, live_until_ledger: entry?.liveUntilLedgerSeq ?? null },
        detail: exists
          ? `Contract ${contractId} exists on this network.`
          : `No contract instance exists for ${contractId} on this network at diagnosis time.`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* resource headroom                                                    */
/* ------------------------------------------------------------------ */

interface NetworkLimits {
  tx_max_instructions: number | null;
  tx_max_disk_read_bytes: number | null;
  tx_max_write_bytes: number | null;
}

async function networkLimits(session: RpcSession): Promise<NetworkLimits> {
  const computeKey = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingContractComputeV0() }),
  ).toXDR("base64");
  const costKey = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingContractLedgerCostV0() }),
  ).toXDR("base64");
  const entries = await session.getLedgerEntries([computeKey, costKey]);
  const out: NetworkLimits = {
    tx_max_instructions: null,
    tx_max_disk_read_bytes: null,
    tx_max_write_bytes: null,
  };
  const compute = entries.get(computeKey);
  if (compute) {
    try {
      const cs = xdr.LedgerEntryData.fromXDR(compute.xdr, "base64").configSetting().contractCompute();
      out.tx_max_instructions = Number(cs.txMaxInstructions().toString());
    } catch {
      /* leave null */
    }
  }
  const cost = entries.get(costKey);
  if (cost) {
    try {
      const cs = xdr.LedgerEntryData.fromXDR(cost.xdr, "base64").configSetting().contractLedgerCost();
      const csAny = cs as unknown as Record<string, () => { toString(): string }>;
      const read = csAny.txMaxDiskReadBytes ?? csAny.txMaxReadBytes;
      if (read) out.tx_max_disk_read_bytes = Number(read.call(cs).toString());
      if (csAny.txMaxWriteBytes) out.tx_max_write_bytes = Number(csAny.txMaxWriteBytes.call(cs).toString());
    } catch {
      /* leave null */
    }
  }
  return out;
}

async function resourceHeadroomCheck(ctx: CheckContext, check: RuleCheck): Promise<CheckResult> {
  if (!ctx.session) return unavailable("resource_usage", "no RPC access for network limits");
  const limits = await networkLimits(ctx.session);
  const resources = ctx.envelope.transaction?.resources ?? null;
  const resource = check.target ?? "instructions";
  const source = "rpc:getLedgerEntries(configSetting)";

  const max =
    resource === "instructions"
      ? limits.tx_max_instructions
      : resource === "disk_read_bytes"
        ? limits.tx_max_disk_read_bytes
        : limits.tx_max_write_bytes;
  if (max === null) return unavailable("resource_usage", `network limit for ${resource} unavailable`);
  ctx.vars[`network_max_${resource}`] = String(max);

  const assert = check.assert ?? "below_network_max";

  if (assert === "sim_at_cap") {
    // A failed *simulation* runs against the network per-tx cap directly.
    if (ctx.envelope.status.phase !== "simulation") {
      return { outcome: "refuted", evidence: [{ type: "resource_usage", source, outcome: "refuted", detail: "Not a simulation failure." }] };
    }
    return {
      outcome: "confirmed",
      evidence: [
        {
          type: "resource_usage",
          source,
          outcome: "confirmed",
          observed: { network_tx_max: max, resource },
          detail: `Simulation runs against the network per-transaction cap (${max} ${resource}); the budget error means execution needs more than that cap.`,
        },
      ],
    };
  }

  if (!resources) return unavailable("resource_usage", "the transaction carries no declared resources");
  const declared =
    resource === "instructions"
      ? resources.instructions
      : resource === "disk_read_bytes"
        ? resources.disk_read_bytes
        : resources.write_bytes;
  ctx.vars[`declared_${resource}`] = String(declared);
  const observed = { declared, network_tx_max: max, resource };

  if (assert === "below_network_max") {
    const confirmed = declared < max;
    return {
      outcome: confirmed ? "confirmed" : "refuted",
      evidence: [
        {
          type: "resource_usage",
          source,
          outcome: confirmed ? "confirmed" : "refuted",
          observed,
          detail: confirmed
            ? `The transaction declared ${declared} ${resource}, below the network per-tx cap of ${max}: there is headroom to raise it.`
            : `The transaction already declared the network per-tx cap for ${resource}.`,
        },
      ],
    };
  }
  if (assert === "at_network_max") {
    const confirmed = declared >= max;
    return {
      outcome: confirmed ? "confirmed" : "refuted",
      evidence: [
        {
          type: "resource_usage",
          source,
          outcome: confirmed ? "confirmed" : "refuted",
          observed,
          detail: confirmed
            ? `Declared ${resource} (${declared}) is at the network cap (${max}); the workload must shrink.`
            : `Declared ${resource} (${declared}) is below the cap (${max}).`,
        },
      ],
    };
  }
  return unavailable("resource_usage", `unknown assert "${check.assert}"`);
}

/* ------------------------------------------------------------------ */
/* auth                                                                 */
/* ------------------------------------------------------------------ */

function authExpirationCheck(ctx: CheckContext, check: RuleCheck): CheckResult {
  const auth = (ctx.envelope.transaction?.auth ?? []).filter((a) => a.credential_type === "address");
  if (auth.length === 0) return unavailable("auth_compare", "no address-credential auth entries in the envelope");
  const refLedger = ctx.envelope.transaction?.ledger ?? ctx.raw.latest_ledger;
  if (refLedger === null || refLedger === undefined) {
    return unavailable("auth_compare", "no reference ledger to compare signature expiration against");
  }
  const evidence: Evidence[] = [];
  let expired = 0;
  for (const a of auth) {
    const isExpired = a.signature_expiration_ledger !== null && a.signature_expiration_ledger < refLedger;
    if (isExpired) {
      expired++;
      ctx.vars.auth_address = a.address ?? "";
      ctx.vars.sig_expiration_ledger = String(a.signature_expiration_ledger);
    }
    evidence.push({
      type: "auth_compare",
      source: "envelope:sorobanAuth",
      outcome: isExpired ? "confirmed" : "info",
      key: a.address ?? "source account",
      observed: {
        signature_expiration_ledger: a.signature_expiration_ledger,
        reference_ledger: refLedger,
        signed: a.signed,
      },
      detail: isExpired
        ? `Signature for ${a.address} expired at ledger ${a.signature_expiration_ledger}, before the transaction's ledger ${refLedger}.`
        : `Signature for ${a.address} was valid until ledger ${a.signature_expiration_ledger}.`,
    });
  }
  const assert = check.assert ?? "expired";
  if (assert === "expired") {
    return { outcome: expired > 0 ? "confirmed" : "refuted", evidence };
  }
  return { outcome: expired === 0 ? "confirmed" : "refuted", evidence };
}

function authSignatureCheck(ctx: CheckContext, check: RuleCheck): CheckResult {
  const all = ctx.envelope.transaction?.auth ?? [];
  const auth = all.filter((a) => a.credential_type === "address");
  if (auth.length === 0) {
    if (all.length > 0 && (check.assert ?? "missing") === "missing") {
      // Only source-account credentials exist; those are covered by the tx
      // signature itself, so "an auth entry was left unsigned" is refuted.
      return {
        outcome: "refuted",
        evidence: [
          {
            type: "auth_compare",
            source: "envelope:sorobanAuth",
            outcome: "refuted",
            detail:
              "All auth entries use source-account credentials, which the transaction signature covers; there is no separately-signed entry to be missing.",
          },
        ],
      };
    }
    return unavailable("auth_compare", "no address-credential auth entries in the envelope");
  }
  const unsignedEntries = auth.filter((a) => a.signed === false);
  const evidence: Evidence[] = auth.map((a) => ({
    type: "auth_compare",
    source: "envelope:sorobanAuth",
    outcome: a.signed === false ? "confirmed" : "info",
    key: a.address ?? "?",
    observed: { signed: a.signed, root_invocation: a.root_invocation },
    detail:
      a.signed === false
        ? `The auth entry for ${a.address} carries no signature payload.`
        : `The auth entry for ${a.address} carries a signature payload.`,
  }));
  if (unsignedEntries.length > 0) ctx.vars.auth_address = unsignedEntries[0]!.address ?? "";
  const assert = check.assert ?? "missing";
  if (assert === "missing") {
    return { outcome: unsignedEntries.length > 0 ? "confirmed" : "refuted", evidence };
  }
  return { outcome: unsignedEntries.length === 0 ? "confirmed" : "refuted", evidence };
}

/* ------------------------------------------------------------------ */
/* wasm spec / declared resources / restore preamble / diagnostics      */
/* ------------------------------------------------------------------ */

function wasmSpecCheck(ctx: CheckContext, check: RuleCheck): CheckResult {
  const ce = ctx.envelope.error.contract_error;
  if (!ce) return unavailable("wasm_spec", "no contract error present");
  const assert = check.assert ?? "resolved";
  const resolved = ce.name !== null;
  if (resolved) {
    ctx.vars.error_name = ce.name!;
    ctx.vars.enum_name = ce.enum_name ?? "";
    if (ce.doc) ctx.vars.error_doc = ce.doc;
  }
  ctx.vars.code = String(ce.code);
  if (ce.contract_id) ctx.vars.contract_id = ce.contract_id;
  const evidence: Evidence[] = [
    {
      type: "wasm_spec",
      source: ce.resolved_from === "sac_builtin" ? "builtin:sac" : "rpc:getLedgerEntries(wasm)+contractspecv0",
      outcome: resolved === (assert === "resolved") ? "confirmed" : "refuted",
      key: ce.contract_id ?? undefined,
      observed: {
        code: ce.code,
        name: ce.name,
        enum: ce.enum_name,
        resolved_from: ce.resolved_from,
      },
      detail: resolved
        ? `Error(Contract, #${ce.code}) resolves to ${ce.enum_name ?? "?"}.${ce.name} via ${ce.resolved_from}.`
        : `Error(Contract, #${ce.code}) could not be resolved to a name.`,
    },
  ];
  return { outcome: resolved === (assert === "resolved") ? "confirmed" : "refuted", evidence };
}

function declaredResourcesCheck(ctx: CheckContext, _check: RuleCheck): CheckResult {
  const r = ctx.envelope.transaction?.resources;
  if (!r) return unavailable("declared_resources", "the transaction carries no sorobanData");
  ctx.vars.resource_fee = r.resource_fee;
  ctx.vars.declared_instructions = String(r.instructions);
  return {
    outcome: "confirmed",
    evidence: [
      {
        type: "declared_resources",
        source: "envelope:sorobanData",
        outcome: "confirmed",
        observed: r,
        detail: "Declared resources extracted from the transaction envelope.",
      },
    ],
  };
}

function restorePreambleCheck(ctx: CheckContext, check: RuleCheck): CheckResult {
  const p = ctx.raw.sim_restore_preamble;
  const assert = check.assert ?? "present";
  if (!p) {
    return {
      outcome: assert === "present" ? "refuted" : "confirmed",
      evidence: [
        {
          type: "restore_preamble",
          source: "simulation:restorePreamble",
          outcome: assert === "present" ? "refuted" : "confirmed",
          detail: "The simulation response carries no restorePreamble.",
        },
      ],
    };
  }
  let keySummaries: string[] = [];
  try {
    const sd = xdr.SorobanTransactionData.fromXDR(p.transactionData, "base64");
    keySummaries = sd
      .resources()
      .footprint()
      .readWrite()
      .map((k) => ledgerKeyView(k).summary);
  } catch {
    /* leave empty */
  }
  ctx.vars.restore_min_fee = p.minResourceFee;
  if (keySummaries[0]) ctx.vars.key = keySummaries[0];
  return {
    outcome: assert === "present" ? "confirmed" : "refuted",
    evidence: [
      {
        type: "restore_preamble",
        source: "simulation:restorePreamble",
        outcome: assert === "present" ? "confirmed" : "refuted",
        observed: {
          min_resource_fee: p.minResourceFee,
          entries_to_restore: keySummaries,
        },
        detail: `Simulation says ${keySummaries.length || "some"} archived entr${keySummaries.length === 1 ? "y" : "ies"} must be restored before this transaction can run.`,
      },
    ],
  };
}

function diagnosticMessageCheck(ctx: CheckContext, check: RuleCheck): CheckResult {
  const needle = (check.contains ?? "").toLowerCase();
  if (!needle) return unavailable("diagnostic", "check is missing `contains`");
  const haystacks: string[] = [];
  for (const e of ctx.raw.facts.errors) {
    if (e.message) haystacks.push(e.message);
    for (const a of e.args) if (typeof a === "string") haystacks.push(a);
  }
  for (const v of ctx.raw.facts.views) {
    if (typeof v.data === "string") haystacks.push(v.data);
    if (Array.isArray(v.data)) for (const d of v.data) if (typeof d === "string") haystacks.push(d);
  }
  if (ctx.raw.sim_error) haystacks.push(ctx.raw.sim_error);
  const hit = haystacks.find((h) => h.toLowerCase().includes(needle));
  const assert = check.assert ?? "present";
  const confirmed = assert === "present" ? hit !== undefined : hit === undefined;
  if (haystacks.length === 0) return unavailable("diagnostic", "no diagnostic messages available to search");
  return {
    outcome: confirmed ? "confirmed" : "refuted",
    evidence: [
      {
        type: "diagnostic",
        source: "diagnostic_events",
        outcome: confirmed ? "confirmed" : "refuted",
        observed: hit ? { matched: hit.slice(0, 200) } : { matched: null },
        expected: `message ${assert === "present" ? "containing" : "not containing"} "${check.contains}"`,
        detail: hit
          ? `Diagnostic message matched: "${hit.slice(0, 120)}"`
          : `No diagnostic message contains "${check.contains}".`,
      },
    ],
  };
}
