/**
 * TransactionEnvelope context extraction: the facts rules need — declared
 * resources, footprint, the invoked call, auth entries, source, fee.
 */

import { xdr, Address, StrKey } from "@stellar/stellar-sdk";
import type { AuthEntryView, FootprintKeyView, TransactionContext } from "../types.js";
import { scValDisplay } from "./scval.js";

function muxedToAddress(m: InstanceType<typeof xdr.MuxedAccount>): string | null {
  try {
    switch (m.switch().name) {
      case "keyTypeEd25519":
        return StrKey.encodeEd25519PublicKey(m.ed25519());
      case "keyTypeMuxedEd25519":
        return StrKey.encodeEd25519PublicKey(m.med25519().ed25519());
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function assetSummary(asset: InstanceType<typeof xdr.Asset>): string {
  try {
    switch (asset.switch().name) {
      case "assetTypeNative":
        return "XLM";
      case "assetTypeCreditAlphanum4": {
        const a = asset.alphaNum4();
        return `${a.assetCode().toString().replace(/\0+$/, "")}:${StrKey.encodeEd25519PublicKey(a.issuer().ed25519())}`;
      }
      case "assetTypeCreditAlphanum12": {
        const a = asset.alphaNum12();
        return `${a.assetCode().toString().replace(/\0+$/, "")}:${StrKey.encodeEd25519PublicKey(a.issuer().ed25519())}`;
      }
      default:
        return asset.switch().name;
    }
  } catch {
    return "<asset>";
  }
}

export function ledgerKeyView(key: InstanceType<typeof xdr.LedgerKey>): FootprintKeyView {
  const b64 = key.toXDR("base64");
  try {
    switch (key.switch().name) {
      case "account": {
        const id = StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519());
        return { type: "account", summary: `account ${id}`, xdr: b64 };
      }
      case "trustline": {
        const id = StrKey.encodeEd25519PublicKey(key.trustLine().accountId().ed25519());
        const asset = key.trustLine().asset();
        let assetStr = "<asset>";
        try {
          switch (asset.switch().name) {
            case "assetTypeNative":
              assetStr = "XLM";
              break;
            case "assetTypeCreditAlphanum4": {
              const a = asset.alphaNum4();
              assetStr = `${a.assetCode().toString().replace(/\0+$/, "")}:${StrKey.encodeEd25519PublicKey(a.issuer().ed25519())}`;
              break;
            }
            case "assetTypeCreditAlphanum12": {
              const a = asset.alphaNum12();
              assetStr = `${a.assetCode().toString().replace(/\0+$/, "")}:${StrKey.encodeEd25519PublicKey(a.issuer().ed25519())}`;
              break;
            }
            case "assetTypePoolShare":
              assetStr = "pool share";
              break;
          }
        } catch {
          /* keep placeholder */
        }
        return { type: "trustline", summary: `trustline ${assetStr} of ${id}`, xdr: b64 };
      }
      case "contractData": {
        const cd = key.contractData();
        const contractId = Address.fromScAddress(cd.contract()).toString();
        const durability = cd.durability().name === "temporary" ? "temporary" : "persistent";
        const k = cd.key();
        const keyDisp =
          k.switch().name === "scvLedgerKeyContractInstance"
            ? "<contract instance>"
            : JSON.stringify(scValDisplay(k));
        return {
          type: "contract_data",
          summary: `${durability} data ${keyDisp} of ${contractId}`,
          xdr: b64,
          contract_id: contractId,
          durability,
          scval_xdr: k.toXDR("base64"),
        };
      }
      case "contractCode": {
        const hash = key.contractCode().hash().toString("hex");
        return { type: "contract_code", summary: `contract code ${hash.slice(0, 8)}…`, xdr: b64 };
      }
      default:
        return { type: key.switch().name, summary: key.switch().name, xdr: b64 };
    }
  } catch {
    return { type: "unknown", summary: "<undecodable key>", xdr: b64 };
  }
}

function invocationSummary(inv: InstanceType<typeof xdr.SorobanAuthorizedInvocation>): string {
  try {
    const fn = inv.function();
    if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
      const c = fn.contractFn();
      const target = Address.fromScAddress(c.contractAddress()).toString();
      return `${target.slice(0, 8)}…${target.slice(-4)}.${c.functionName().toString()}(${(c.args() ?? []).length} args)`;
    }
    return fn.switch().name;
  } catch {
    return "<invocation>";
  }
}

function authView(entry: InstanceType<typeof xdr.SorobanAuthorizationEntry>): AuthEntryView {
  const creds = entry.credentials();
  if (creds.switch().name === "sorobanCredentialsSourceAccount") {
    return {
      credential_type: "source_account",
      address: null,
      nonce: null,
      signature_expiration_ledger: null,
      signed: null, // implicit: covered by the transaction signature itself
      root_invocation: invocationSummary(entry.rootInvocation()),
    };
  }
  const a = creds.address();
  let address: string | null = null;
  try {
    address = Address.fromScAddress(a.address()).toString();
  } catch {
    /* keep null */
  }
  let signed = false;
  try {
    const sig = a.signature();
    signed =
      sig.switch().name !== "scvVoid" &&
      !(sig.switch().name === "scvVec" && (sig.vec() ?? []).length === 0);
  } catch {
    signed = false;
  }
  return {
    credential_type: "address",
    address,
    nonce: a.nonce().toString(),
    signature_expiration_ledger: a.signatureExpirationLedger(),
    signed,
    root_invocation: invocationSummary(entry.rootInvocation()),
  };
}

export function parseEnvelope(envelopeXdrB64: string): TransactionContext {
  const env = xdr.TransactionEnvelope.fromXDR(envelopeXdrB64, "base64");
  let tx: InstanceType<typeof xdr.Transaction> | null = null;
  let sourceV0: string | null = null;

  switch (env.switch().name) {
    case "envelopeTypeTxFeeBump": {
      const innerEnv = env.feeBump().tx().innerTx();
      tx = innerEnv.v1().tx();
      break;
    }
    case "envelopeTypeTx":
      tx = env.v1().tx();
      break;
    case "envelopeTypeTxV0": {
      const v0 = env.v0().tx();
      sourceV0 = StrKey.encodeEd25519PublicKey(v0.sourceAccountEd25519());
      // v0 transactions predate Soroban entirely; extract what we can.
      return {
        hash: null,
        ledger: null,
        created_at: null,
        source_account: sourceV0,
        fee: v0.fee().toString(),
        resources: null,
        footprint: null,
        invocation: null,
        auth: [],
        operations: v0.operations().map((op, index) => ({ type: op.body().switch().name, index })),
        failed_operation_index: null,
      };
    }
    default:
      throw new Error(`unsupported envelope type ${env.switch().name}`);
  }

  const ops = tx.operations();
  const operations = ops.map((op, index) => ({ type: op.body().switch().name, index }));

  // Soroban data (declared resources + footprint)
  let resources: TransactionContext["resources"] = null;
  let footprint: TransactionContext["footprint"] = null;
  try {
    if (tx.ext().switch() === 1) {
      const sd = tx.ext().sorobanData();
      const r = sd.resources();
      let diskReadBytes = 0;
      const rAny = r as unknown as Record<string, () => number>;
      // p23 renamed readBytes -> diskReadBytes; tolerate both SDK spellings.
      if (typeof rAny.diskReadBytes === "function") diskReadBytes = rAny.diskReadBytes();
      else if (typeof rAny.readBytes === "function") diskReadBytes = rAny.readBytes();
      resources = {
        instructions: r.instructions(),
        disk_read_bytes: diskReadBytes,
        write_bytes: r.writeBytes(),
        resource_fee: sd.resourceFee().toString(),
      };
      footprint = {
        read_only: r.footprint().readOnly().map(ledgerKeyView),
        read_write: r.footprint().readWrite().map(ledgerKeyView),
      };
    }
  } catch {
    /* absent sorobanData is normal for classic txs */
  }

  // Invocation + auth from the first InvokeHostFunction op
  let invocation: TransactionContext["invocation"] = null;
  let auth: AuthEntryView[] = [];
  for (const op of ops) {
    if (op.body().switch().name !== "invokeHostFunction") continue;
    const ihf = op.body().invokeHostFunctionOp();
    const hf = ihf.hostFunction();
    if (hf.switch().name === "hostFunctionTypeInvokeContract") {
      const ic = hf.invokeContract();
      let contractId: string | null = null;
      try {
        contractId = Address.fromScAddress(ic.contractAddress()).toString();
      } catch {
        /* keep null */
      }
      invocation = {
        contract_id: contractId,
        function_name: ic.functionName().toString(),
        args: (ic.args() ?? []).map(scValDisplay),
        host_function_type: "invoke_contract",
      };
    } else {
      invocation = {
        contract_id: null,
        function_name: null,
        args: [],
        host_function_type: hf.switch().name.replace("hostFunctionType", "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
      };
    }
    try {
      auth = (ihf.auth() ?? []).map(authView);
    } catch {
      auth = [];
    }
    break;
  }

  return {
    hash: null,
    ledger: null,
    created_at: null,
    source_account: muxedToAddress(tx.sourceAccount()),
    fee: tx.fee().toString(),
    resources,
    footprint,
    invocation,
    auth,
    operations,
    failed_operation_index: null,
  };
}

export { assetSummary };
