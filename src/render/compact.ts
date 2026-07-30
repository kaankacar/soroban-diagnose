/**
 * Compact view of the envelope for token-budgeted consumers (MCP default,
 * CLI default). Structure-preserving: the result still validates against the
 * envelope schema — arrays are shorter and long strings are truncated, but
 * nothing is renamed or reshaped. Full detail lives behind verbose mode.
 */

import type { Diagnosis, DiagnosticEventView, Envelope, Evidence } from "../types.js";

const MAX_EVENTS = 4;
const MAX_DIAGNOSES = 3;
const MAX_EVIDENCE_PER_DIAGNOSIS = 3;
const MAX_STRING = 200;
const MAX_ARG_CHARS = 120;

function clipString(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
}

function clipTo(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function clipValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return clipString(v);
  if (Array.isArray(v)) return (depth > 2 ? v.slice(0, 3) : v.slice(0, 8)).map((x) => clipValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v).slice(0, 12)) out[k] = clipValue(val, depth + 1);
    return out;
  }
  return v;
}

function compactEvidence(evidence: Evidence[]): Evidence[] {
  // Confirmed/refuted evidence is the substance; info entries pad tokens.
  const substantive = evidence.filter((e) => e.outcome !== "info");
  const info = evidence.filter((e) => e.outcome === "info");
  return [...substantive, ...info.slice(0, 1)]
    .slice(0, MAX_EVIDENCE_PER_DIAGNOSIS)
    .map((e) => ({
      ...e,
      // wasm_spec observations duplicate envelope.error.contract_error.
      observed: e.observed === undefined || e.type === "wasm_spec" ? undefined : clipValue(e.observed),
      expected: e.expected === undefined ? undefined : clipValue(e.expected),
      detail: e.detail ? clipTo(e.detail, 150) : e.detail,
      key: e.key ? clipTo(e.key, 70) : e.key,
    }));
}

/**
 * The top diagnosis keeps its evidence and fix; runners-up shrink to their
 * headline (cause, confidence, explanation) — their full detail is in the
 * verbose envelope.
 */
function compactDiagnosis(d: Diagnosis, index: number): Diagnosis {
  if (index === 0) return { ...d, evidence: compactEvidence(d.evidence) };
  return {
    ...d,
    explanation: clipString(d.explanation),
    evidence: [],
    fix: d.fix ? { summary: clipString(d.fix.summary), commands: [] } : null,
    verify: [],
    references: [],
  };
}

function compactEvent(e: DiagnosticEventView): DiagnosticEventView {
  return {
    ...e,
    // Long hex hashes in topics carry no diagnostic value in compact form.
    topics: e.topics.map((t) => (typeof t === "string" ? clipTo(t, 60) : clipValue(t))),
    data: clipValue(e.data),
  };
}

/**
 * Events worth spending tokens on: errors, the call chain, and logs.
 * core_metrics events are host accounting noise for diagnosis purposes.
 */
function selectEvents(events: DiagnosticEventView[]): DiagnosticEventView[] {
  const topic0 = (e: DiagnosticEventView) => (typeof e.topics[0] === "string" ? e.topics[0] : "");
  const substantive = events.filter((e) => topic0(e) !== "core_metrics");
  const pool = substantive.length > 0 ? substantive : events;
  if (pool.length <= MAX_EVENTS) return pool.map(compactEvent);
  const errors = pool.filter((e) => topic0(e) === "error");
  const rest = pool.filter((e) => topic0(e) !== "error");
  const picked = [...errors.slice(0, 4), ...rest.slice(0, Math.max(0, MAX_EVENTS - Math.min(errors.length, 4)))];
  // Preserve original ordering.
  const set = new Set(picked);
  return pool.filter((e) => set.has(e)).map(compactEvent);
}

export function compactEnvelope(envelope: Envelope): Envelope {
  const selected = selectEvents(envelope.diagnostic_events);
  const dropped = envelope.diagnostic_events.length - selected.length;
  return {
    ...envelope,
    diagnostic_events: selected,
    diagnoses: envelope.diagnoses.slice(0, MAX_DIAGNOSES).map((d, i) => compactDiagnosis(d, i)),
    eliminated: [],
    references: envelope.references.slice(0, 2),
    unresolved:
      dropped > 0
        ? [
            ...envelope.unresolved,
            {
              reason: "input_incomplete" as const,
              detail: `compact view: ${dropped} diagnostic events omitted (verbose mode has all).`,
            },
          ]
        : envelope.unresolved,
    transaction: envelope.transaction
      ? {
          ...envelope.transaction,
          invocation: envelope.transaction.invocation
            ? {
                ...envelope.transaction.invocation,
                args: envelope.transaction.invocation.args.map((a) => {
                  const s = JSON.stringify(a) ?? "null";
                  return s.length > MAX_ARG_CHARS ? `${s.slice(0, MAX_ARG_CHARS)}…` : a;
                }),
              }
            : null,
          operations: envelope.transaction.operations.slice(0, 6),
          footprint: envelope.transaction.footprint
            ? {
                // Summaries only in the compact view: the raw XDR keys are
                // for tooling and live in the verbose envelope.
                read_only: envelope.transaction.footprint.read_only
                  .slice(0, 3)
                  .map((k) => ({ type: k.type, summary: clipTo(k.summary, 80), xdr: "" })),
                read_write: envelope.transaction.footprint.read_write
                  .slice(0, 3)
                  .map((k) => ({ type: k.type, summary: clipTo(k.summary, 80), xdr: "" })),
              }
            : null,
          auth: envelope.transaction.auth.slice(0, 3).map((a) => ({
            ...a,
            nonce: a.nonce ? "…" : a.nonce,
            root_invocation: a.root_invocation.length > 60 ? `${a.root_invocation.slice(0, 60)}…` : a.root_invocation,
          })),
        }
      : null,
  };
}
