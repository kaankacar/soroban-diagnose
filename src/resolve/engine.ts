/**
 * The deterministic resolver. No model anywhere in this path: rules are
 * matched structurally, checks run state lookups, confidence comes from the
 * table (hard-capped at 0.5 when nothing confirmed), ranking is stable.
 */

import type { Diagnosis, Envelope, Evidence } from "../types.js";
import type { RawFailure } from "../ingest.js";
import type { RpcSession } from "../rpc.js";
import type { Rule, RuleMatch, RuleTable } from "./ruleschema.js";
import { protocolMatches } from "./ruleschema.js";
import { runCheck, type CheckContext } from "./checks.js";

export const UNCONFIRMED_CONFIDENCE_CEILING = 0.5;

export interface EliminatedHypothesis {
  cause_id: string;
  evidence: Evidence[];
}

export interface ResolveOutcome {
  diagnoses: Diagnosis[];
  eliminated: EliminatedHypothesis[];
}

/* ------------------------------------------------------------------ */
/* matching                                                             */
/* ------------------------------------------------------------------ */

function asList<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function globMatch(pattern: string, value: string | null): boolean {
  if (value === null) return false;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

export function ruleMatches(match: RuleMatch, envelope: Envelope, raw: RawFailure): boolean {
  const txs = asList(match.tx_result);
  if (txs.length > 0 && !txs.some((t) => globMatch(t, envelope.status.tx))) return false;

  const ops = asList(match.op_result);
  if (ops.length > 0 && !ops.some((o) => globMatch(o, envelope.status.op))) return false;

  const ids = asList(match.error_id);
  if (ids.length > 0 && !ids.some((i) => globMatch(i, envelope.error.id))) return false;

  const notIds = asList(match.error_id_not);
  if (notIds.length > 0 && notIds.some((i) => globMatch(i, envelope.error.id))) return false;

  const hosts = asList(match.host_error);
  if (hosts.length > 0) {
    const he = envelope.error.host_error;
    const heStr = he ? `${he.type}.${he.code}` : null;
    if (!hosts.some((h) => globMatch(h, heStr))) return false;
  }

  const codes = asList(match.contract_error_code);
  if (codes.length > 0) {
    const c = envelope.error.contract_error?.code;
    if (c === undefined || !codes.includes(c)) return false;
  }

  const names = asList(match.contract_error_name);
  if (names.length > 0) {
    const n = envelope.error.contract_error?.name ?? null;
    if (!names.some((x) => globMatch(x, n))) return false;
  }

  if (match.sac !== undefined) {
    const isSac = envelope.error.contract_error?.resolved_from === "sac_builtin";
    if (match.sac !== isSac) return false;
  }

  const fns = asList(match.function);
  if (fns.length > 0) {
    const f = envelope.transaction?.invocation?.function_name ?? null;
    if (!fns.some((x) => globMatch(x, f))) return false;
  }

  const kinds = asList(match.input_kind);
  if (kinds.length > 0 && !kinds.includes(envelope.input.kind)) return false;

  const phases = asList(match.phase);
  if (phases.length > 0 && !phases.includes(envelope.status.phase)) return false;

  if (match.has_restore_preamble !== undefined) {
    if (match.has_restore_preamble !== (raw.sim_restore_preamble !== null)) return false;
  }

  const needles = asList(match.diagnostic_contains);
  if (needles.length > 0) {
    const haystacks: string[] = [];
    for (const e of raw.facts.errors) {
      if (e.message) haystacks.push(e.message);
      for (const a of e.args) if (typeof a === "string") haystacks.push(a);
    }
    for (const v of raw.facts.views) {
      if (typeof v.data === "string") haystacks.push(v.data);
      if (Array.isArray(v.data)) for (const d of v.data) if (typeof d === "string") haystacks.push(d);
    }
    if (raw.sim_error) haystacks.push(raw.sim_error);
    const lower = haystacks.map((h) => h.toLowerCase());
    if (!needles.some((n) => lower.some((h) => h.includes(n.toLowerCase())))) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* interpolation                                                        */
/* ------------------------------------------------------------------ */

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole,
  );
}

function baseVars(envelope: Envelope, raw: RawFailure): Record<string, string> {
  const vars: Record<string, string> = {};
  const t = envelope.transaction;
  const put = (k: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") vars[k] = String(v);
  };
  put("network", envelope.network === "unknown" ? "testnet" : envelope.network);
  put("tx_hash", t?.hash);
  put("op_code", envelope.status.op);
  put("tx_code", envelope.status.tx);
  put("source", t?.source_account);
  put("contract_id", envelope.error.contract_error?.contract_id ?? t?.invocation?.contract_id);
  put("function", t?.invocation?.function_name);
  put("code", envelope.error.contract_error?.code);
  put("error_name", envelope.error.contract_error?.name);
  put("enum_name", envelope.error.contract_error?.enum_name);
  put("error_doc", envelope.error.contract_error?.doc);
  put("tx_ledger", t?.ledger);
  put("current_ledger", raw.latest_ledger);
  put("fee", t?.fee);
  put("resource_fee", t?.resources?.resource_fee);
  put("declared_instructions", t?.resources?.instructions);
  (t?.invocation?.args ?? []).forEach((a, i) => {
    if (typeof a === "string" || typeof a === "number") put(`arg${i}`, String(a));
  });
  return vars;
}

/* ------------------------------------------------------------------ */
/* engine                                                               */
/* ------------------------------------------------------------------ */

export async function resolveDiagnoses(
  session: RpcSession | null,
  table: RuleTable,
  envelope: Envelope,
  raw: RawFailure,
): Promise<ResolveOutcome> {
  const diagnoses: Diagnosis[] = [];
  const eliminated: EliminatedHypothesis[] = [];

  for (const rule of table.rules) {
    if (!protocolMatches(rule.protocol, envelope.protocol_version)) continue;
    if (!ruleMatches(rule.match, envelope, raw)) continue;

    const ctx: CheckContext = { session, envelope, raw, vars: baseVars(envelope, raw) };
    const evidence: Evidence[] = [];
    let confirmedCount = 0;
    let refuted = false;
    let requiredUnconfirmed = false;

    for (const check of rule.checks ?? []) {
      const result = await runCheck(ctx, check);
      evidence.push(...result.evidence);
      if (result.outcome === "confirmed") confirmedCount++;
      if (result.outcome === "refuted") {
        refuted = true;
        break; // one refutation eliminates the hypothesis
      }
      if (check.required && result.outcome !== "confirmed") requiredUnconfirmed = true;
    }

    if (refuted) {
      eliminated.push({ cause_id: rule.id, evidence });
      continue;
    }

    const confirmed = !requiredUnconfirmed && (confirmedCount > 0 || rule.conclusive === true);
    const confidence = confirmed
      ? rule.confidence
      : Math.min(rule.confidence, UNCONFIRMED_CONFIDENCE_CEILING);

    diagnoses.push({
      cause_id: rule.id,
      confidence,
      confirmed,
      explanation: interpolate(rule.explanation.trim(), ctx.vars),
      evidence,
      fix: rule.fix
        ? {
            summary: interpolate(rule.fix.summary.trim(), ctx.vars),
            commands: (rule.fix.commands ?? []).map((c) => interpolate(c, ctx.vars)),
          }
        : null,
      verify: (rule.verify ?? []).map((v) => interpolate(v, ctx.vars)),
      references: rule.references ?? [],
    });
  }

  // Stable ranking: confidence desc, then confirmed first, then table order.
  const order = new Map(table.rules.map((r, i) => [r.id, i]));
  diagnoses.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    return (order.get(a.cause_id) ?? 0) - (order.get(b.cause_id) ?? 0);
  });

  return { diagnoses, eliminated };
}
