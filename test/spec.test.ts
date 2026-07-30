/**
 * resolve_contract_error is the single highest-value function in the repo,
 * so it gets the hardest tests — especially the degradation paths, which must
 * never guess a name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contractSpecSection, customSections } from "../src/decode/wasm.js";
import {
  errorEnumsFromEntries,
  parseSpecEntries,
  resolveFromEnums,
  SAC_ERRORS,
} from "../src/decode/spec.js";

const wasm = readFileSync(join(__dirname, "data", "testchaos.wasm"));

describe("wasm custom section walker", () => {
  it("finds the contractspecv0 section in a real contract", () => {
    const names = customSections(wasm).map((s) => s.name);
    expect(names).toContain("contractspecv0");
    expect(names).toContain("contractenvmetav0");
  });

  it("rejects non-wasm bytes without guessing", () => {
    expect(() => customSections(Buffer.from("definitely not wasm bytes here"))).toThrow(/magic/);
  });

  it("rejects truncated wasm", () => {
    const truncated = wasm.subarray(0, 40);
    expect(() => customSections(truncated)).toThrow(/end of file/);
  });

  it("returns null spec for a wasm module without the section", () => {
    // minimal empty wasm module: magic + version only
    const empty = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    expect(contractSpecSection(empty)).toBeNull();
  });
});

describe("spec entry parsing", () => {
  const enums = errorEnumsFromEntries(parseSpecEntries(contractSpecSection(wasm)!));

  it("extracts the error enum with names, values, and docs", () => {
    expect(enums).toHaveLength(1);
    expect(enums[0]!.name).toBe("ChaosError");
    const byValue = Object.fromEntries(enums[0]!.cases.map((c) => [c.value, c.name]));
    expect(byValue).toEqual({
      1: "InsufficientBalance",
      2: "Unauthorized",
      3: "DeadlinePassed",
      4: "AlreadyInitialized",
      5: "LimitExceeded",
      7: "InvalidAmount",
    });
    expect(enums[0]!.cases[0]!.doc).toMatch(/balance is too low/);
  });

  it("resolves an in-range code", () => {
    const r = resolveFromEnums(enums, "C".padEnd(56, "A"), 3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.name).toBe("DeadlinePassed");
      expect(r.info.enum_name).toBe("ChaosError");
      expect(r.info.resolved_from).toBe("contractspecv0");
    }
  });

  it("degrades honestly on a gap value (6) instead of guessing a neighbor", () => {
    const r = resolveFromEnums(enums, null, 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("code_not_in_enum");
    expect(r.info.name).toBeNull();
    expect(r.info.resolved_from).toBeNull();
  });

  it("degrades honestly on out-of-range codes", () => {
    for (const code of [0, 99, 4294967295]) {
      const r = resolveFromEnums(enums, null, code);
      expect(r.ok).toBe(false);
      expect(r.info.name).toBeNull();
      expect(r.info.resolved_from).toBeNull();
    }
  });

  it("degrades honestly when the spec has no error enums", () => {
    const r = resolveFromEnums([], null, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_error_enum");
  });

  it("reports ambiguity when two enums share a value", () => {
    const doubled = [enums[0]!, { ...enums[0]!, name: "OtherError" }];
    const r = resolveFromEnums(doubled, null, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ambiguous_with).toEqual(["OtherError.InsufficientBalance"]);
  });
});

describe("SAC built-in error table", () => {
  it("covers the documented range and reserves code 1", () => {
    expect(SAC_ERRORS[1]).toBeUndefined(); // reserved upstream
    expect(SAC_ERRORS[10]!.name).toBe("BalanceError");
    expect(SAC_ERRORS[13]!.name).toBe("TrustlineMissingError");
    expect(SAC_ERRORS[15]!.name).toBe("TooManyAccountSubentries");
    expect(SAC_ERRORS[16]).toBeUndefined();
  });
});
