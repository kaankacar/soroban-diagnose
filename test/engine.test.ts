/**
 * Rule engine unit tests: matching semantics, protocol ranges, interpolation,
 * confidence discipline, and the bundled rule table's own validity.
 */

import { describe, expect, it } from "vitest";
import { interpolate, resolveDiagnoses, ruleMatches } from "../src/resolve/engine.js";
import { loadRuleTable, protocolMatches, validateRuleTable } from "../src/resolve/ruleschema.js";
import { defaultRulesPath } from "../src/index.js";
import type { Envelope } from "../src/types.js";
import type { RawFailure } from "../src/ingest.js";

function envelopeStub(overrides: Partial<Envelope> = {}): Envelope {
  return {
    schema_version: "1.0",
    network: "testnet",
    protocol_version: 27,
    input: { kind: "tx_hash", ref: "x" },
    status: { tx: "txFAILED", op: "INVOKE_HOST_FUNCTION_TRAPPED", phase: "apply", successful: false },
    error: {
      id: "soroban.host.budget.exceeded_limit",
      layer: "host",
      raw: "Error(Budget, ExceededLimit)",
      host_error: { type: "Budget", code: "ExceededLimit" },
      contract_error: null,
    },
    diagnostic_events: [],
    diagnoses: [],
    eliminated: [],
    unresolved: [],
    references: [],
    transaction: null,
    ...overrides,
  };
}

function rawStub(): RawFailure {
  return {
    input: { kind: "tx_hash", ref: "x" },
    phase: "apply",
    network: "testnet",
    protocol_version: 27,
    latest_ledger: 100,
    tx_result: null,
    tx_context: null,
    facts: { errors: [], calls: [], views: [] },
    sim_error: null,
    sim_restore_preamble: null,
    successful: false,
    notes: [],
  };
}

describe("protocolMatches", () => {
  it.each([
    [">=23", 27, true],
    [">=23", 22, false],
    ["<=26", 27, false],
    ["23-26", 25, true],
    ["23-26", 27, false],
    ["27", 27, true],
    ["*", 1, true],
    [undefined, 27, true],
  ])("%s vs %s -> %s", (expr, version, expected) => {
    expect(protocolMatches(expr as string | undefined, version as number)).toBe(expected);
  });

  it("cannot exclude an unknown protocol version", () => {
    expect(protocolMatches(">=23", null)).toBe(true);
  });
});

describe("ruleMatches", () => {
  const env = envelopeStub();
  const raw = rawStub();

  it("matches on exact values and lists", () => {
    expect(ruleMatches({ tx_result: "txFAILED" }, env, raw)).toBe(true);
    expect(ruleMatches({ tx_result: ["txBAD_SEQ", "txFAILED"] }, env, raw)).toBe(true);
    expect(ruleMatches({ tx_result: "txBAD_SEQ" }, env, raw)).toBe(false);
  });

  it("supports trailing-star globs on error ids", () => {
    expect(ruleMatches({ error_id: "soroban.host.budget.*" }, env, raw)).toBe(true);
    expect(ruleMatches({ error_id: "soroban.host.auth.*" }, env, raw)).toBe(false);
  });

  it("supports negative error id matching", () => {
    expect(ruleMatches({ error_id: "soroban.*", error_id_not: "soroban.host.budget.*" }, env, raw)).toBe(false);
  });

  it("matches host errors as Type.Code", () => {
    expect(ruleMatches({ host_error: "Budget.ExceededLimit" }, env, raw)).toBe(true);
    expect(ruleMatches({ host_error: "Budget.*" }, env, raw)).toBe(true);
    expect(ruleMatches({ host_error: "Auth.InvalidAction" }, env, raw)).toBe(false);
  });

  it("ANDs conditions together", () => {
    expect(ruleMatches({ tx_result: "txFAILED", phase: "simulation" }, env, raw)).toBe(false);
  });

  it("searches diagnostic messages case-insensitively", () => {
    const raw2 = rawStub();
    raw2.facts.errors.push({
      error: { type: "Auth", code: "InvalidInput", contractCode: null },
      message: "Signature Has Expired",
      args: [],
      contract_id: null,
      in_successful_contract_call: false,
    });
    expect(ruleMatches({ diagnostic_contains: "signature has expired" }, env, raw2)).toBe(true);
    expect(ruleMatches({ diagnostic_contains: "nonce" }, env, raw2)).toBe(false);
  });
});

describe("interpolate", () => {
  it("fills known variables and leaves unknown placeholders visible", () => {
    expect(interpolate("restore {key} on {network} ({nope})", { key: "K", network: "testnet" })).toBe(
      "restore K on testnet ({nope})",
    );
  });
});

describe("confidence discipline", () => {
  it("caps rules without confirming evidence at 0.5", async () => {
    const table = validateRuleTable(
      {
        version: "test",
        rules: [
          {
            id: "guess",
            match: { host_error: "Budget.ExceededLimit" },
            checks: [],
            confidence: 0.99,
            explanation: "a guess with no evidence",
          },
        ],
      },
      "inline",
    );
    const { diagnoses } = await resolveDiagnoses(null, table, envelopeStub(), rawStub());
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]!.confidence).toBe(0.5);
    expect(diagnoses[0]!.confirmed).toBe(false);
  });

  it("lets conclusive submission-level rules carry table confidence", async () => {
    const table = validateRuleTable(
      {
        version: "test",
        rules: [
          {
            id: "definitive",
            match: { tx_result: "txFAILED" },
            conclusive: true,
            confidence: 0.95,
            explanation: "the code is the cause",
          },
        ],
      },
      "inline",
    );
    const { diagnoses } = await resolveDiagnoses(null, table, envelopeStub(), rawStub());
    expect(diagnoses[0]!.confidence).toBe(0.95);
    expect(diagnoses[0]!.confirmed).toBe(true);
  });
});

describe("bundled rule table", () => {
  it("loads, validates, and keeps ids unique", () => {
    const table = loadRuleTable(defaultRulesPath());
    expect(table.rules.length).toBeGreaterThanOrEqual(30);
    const ids = table.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects malformed tables loudly", () => {
    expect(() => validateRuleTable({ version: "x", rules: [{ id: "a" }] }, "inline")).toThrow(/match/);
    expect(() =>
      validateRuleTable(
        { version: "x", rules: [{ id: "a", match: { nonsense: 1 }, confidence: 0.5, explanation: "e" }] },
        "inline",
      ),
    ).toThrow(/unknown match key/);
    expect(() =>
      validateRuleTable(
        { version: "x", rules: [{ id: "a", match: { tx_result: "t" }, confidence: 2, explanation: "e" }] },
        "inline",
      ),
    ).toThrow(/confidence/);
  });
});
