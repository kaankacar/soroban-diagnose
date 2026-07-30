/**
 * Rule table schema and loader. Rules are data (YAML), versioned separately
 * from code, updatable without a release. The loader validates hard so a
 * broken table fails loudly at startup, not silently at diagnosis time.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export interface RuleMatch {
  tx_result?: string | string[];
  op_result?: string | string[];
  /** "soroban.host.storage.*" — trailing * is a prefix glob. */
  error_id?: string | string[];
  /** Globs that must NOT match the error id. */
  error_id_not?: string | string[];
  /** "Budget.ExceededLimit" or "Auth.*". */
  host_error?: string | string[];
  contract_error_code?: number | number[];
  contract_error_name?: string | string[];
  /** True: the erroring contract must be a built-in Stellar Asset Contract. */
  sac?: boolean;
  function?: string | string[];
  input_kind?: string | string[];
  phase?: string | string[];
  has_restore_preamble?: boolean;
  /** Case-insensitive substring over diagnostic error messages. */
  diagnostic_contains?: string | string[];
}

export interface RuleCheck {
  kind:
    | "ttl"
    | "trustline"
    | "account"
    | "resource_headroom"
    | "auth_expiration"
    | "auth_signature"
    | "wasm_spec"
    | "declared_resources"
    | "restore_preamble"
    | "diagnostic_message";
  /** Check-specific target/selector; see checks.ts for each kind. */
  target?: string;
  assert?: string;
  /** For diagnostic_message: the substring to require/forbid. */
  contains?: string;
  /**
   * This check discriminates the hypothesis from sibling rules: the rule
   * only counts as confirmed when THIS check confirms. Unavailable required
   * checks cap the rule at the unconfirmed ceiling; refutation still
   * eliminates as usual.
   */
  required?: boolean;
}

export interface Rule {
  id: string;
  /** Protocol applicability, e.g. ">=23", "<=26", "23-26", "*". */
  protocol?: string;
  match: RuleMatch;
  checks?: RuleCheck[];
  /**
   * The match itself is definitive (1:1 result-code causes, submission
   * rejections). Grants full table confidence without a confirming lookup.
   * Contract-layer causes must NOT use this — they need state evidence.
   */
  conclusive?: boolean;
  confidence: number;
  explanation: string;
  fix?: { summary: string; commands?: string[] };
  verify?: string[];
  references?: string[];
}

export interface RuleTable {
  version: string;
  rules: Rule[];
}

const CHECK_KINDS = new Set([
  "ttl",
  "trustline",
  "account",
  "resource_headroom",
  "auth_expiration",
  "auth_signature",
  "wasm_spec",
  "declared_resources",
  "restore_preamble",
  "diagnostic_message",
]);

const MATCH_KEYS = new Set([
  "tx_result",
  "op_result",
  "error_id",
  "error_id_not",
  "host_error",
  "contract_error_code",
  "contract_error_name",
  "sac",
  "function",
  "input_kind",
  "phase",
  "has_restore_preamble",
  "diagnostic_contains",
]);

export function validateRuleTable(doc: unknown, sourceLabel: string): RuleTable {
  const fail: (msg: string) => never = (msg) => {
    throw new Error(`rule table ${sourceLabel}: ${msg}`);
  };
  if (!doc || typeof doc !== "object") fail("not a YAML mapping");
  const d = doc as { version?: unknown; rules?: unknown };
  if (typeof d.version !== "string") fail("missing string field `version`");
  if (!Array.isArray(d.rules)) fail("missing list field `rules`");
  const seen = new Set<string>();
  for (const [i, r] of (d.rules as unknown[]).entries()) {
    const where = `rules[${i}]`;
    if (!r || typeof r !== "object") fail(`${where}: not a mapping`);
    const rule = r as Partial<Rule>;
    if (!rule.id || typeof rule.id !== "string") fail(`${where}: missing id`);
    if (seen.has(rule.id)) fail(`${where}: duplicate id "${rule.id}"`);
    seen.add(rule.id);
    if (!rule.match || typeof rule.match !== "object" || Object.keys(rule.match).length === 0) {
      fail(`${rule.id}: missing or empty match`);
    }
    for (const k of Object.keys(rule.match as object)) {
      if (!MATCH_KEYS.has(k)) fail(`${rule.id}: unknown match key "${k}"`);
    }
    if (typeof rule.confidence !== "number" || rule.confidence <= 0 || rule.confidence > 1) {
      fail(`${rule.id}: confidence must be in (0, 1]`);
    }
    if (!rule.explanation || typeof rule.explanation !== "string") {
      fail(`${rule.id}: missing explanation`);
    }
    for (const c of rule.checks ?? []) {
      if (!c || typeof c !== "object" || !CHECK_KINDS.has((c as RuleCheck).kind)) {
        fail(`${rule.id}: check with unknown kind "${(c as RuleCheck)?.kind}"`);
      }
    }
    const hasChecks = (rule.checks ?? []).length > 0;
    if (rule.conclusive && hasChecks === false && rule.match.contract_error_code !== undefined) {
      fail(`${rule.id}: contract-layer rules may not be conclusive without checks`);
    }
  }
  return doc as RuleTable;
}

export function loadRuleTable(path: string): RuleTable {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  return validateRuleTable(doc, path);
}

/** ">=23", "<=26", "23-26", "27", "*" against a protocol version. */
export function protocolMatches(expr: string | undefined, version: number | null): boolean {
  if (!expr || expr === "*") return true;
  if (version === null) return true; // cannot exclude what we do not know
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(expr);
  if (range) return version >= Number(range[1]) && version <= Number(range[2]);
  const cmp = /^(>=|<=|>|<|==?)?\s*(\d+)$/.exec(expr);
  if (!cmp) return true;
  const [, op, numStr] = cmp;
  const num = Number(numStr);
  switch (op) {
    case ">":
      return version > num;
    case ">=":
    case undefined:
    case "":
      return version >= num;
    case "<":
      return version < num;
    case "<=":
      return version <= num;
    default:
      return version === num;
  }
}
