/**
 * Best-effort human display of ScVal values. Never throws: anything that
 * resists decoding renders as an opaque tag rather than crashing a diagnosis.
 */

import { xdr, Address, scValToNative } from "@stellar/stellar-sdk";
import { scErrorTypeName, scErrorCodeName, hostErrorRaw, contractErrorRaw } from "../xdrnames.js";

export interface ScErrorView {
  type: string;
  code: string;
  /** Numeric code for Error(Contract, #n); null otherwise. */
  contractCode: number | null;
}

export function scErrorView(err: InstanceType<typeof xdr.ScError>): ScErrorView {
  const type = scErrorTypeName(err.switch().name);
  if (err.switch().name === "sceContract") {
    const code = err.contractCode();
    return { type: "Contract", code: `#${code}`, contractCode: code };
  }
  // Non-contract errors carry an ScErrorCode.
  let codeName: string;
  try {
    codeName = scErrorCodeName((err.value() as { name: string }).name);
  } catch {
    codeName = "Unknown";
  }
  return { type, code: codeName, contractCode: null };
}

export function scErrorRaw(view: ScErrorView): string {
  return view.contractCode !== null
    ? contractErrorRaw(view.contractCode)
    : hostErrorRaw(view.type, view.code);
}

export function scValDisplay(val: InstanceType<typeof xdr.ScVal>): unknown {
  try {
    switch (val.switch().name) {
      case "scvError":
        return scErrorRaw(scErrorView(val.error()));
      case "scvAddress":
        return Address.fromScAddress(val.address()).toString();
      case "scvBytes": {
        const b = val.bytes();
        const hex = Buffer.from(b).toString("hex");
        return hex.length > 64 ? `${hex.slice(0, 64)}…(${b.length} bytes)` : hex;
      }
      case "scvVec":
        return (val.vec() ?? []).map(scValDisplay);
      case "scvMap": {
        const out: Record<string, unknown> = {};
        for (const kv of val.map() ?? []) {
          out[String(scValDisplay(kv.key()))] = scValDisplay(kv.val());
        }
        return out;
      }
      case "scvContractInstance":
        return "<contract instance>";
      default: {
        const native = scValToNative(val);
        return typeof native === "bigint" ? native.toString() : native;
      }
    }
  } catch {
    try {
      return `<${val.switch().name}>`;
    } catch {
      return "<undecodable>";
    }
  }
}
