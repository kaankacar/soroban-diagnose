/**
 * Human terminal rendering. Plain ANSI, no dependencies, degrades to
 * monochrome when not a TTY.
 */

import type { Envelope } from "../types.js";

interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

const colorized: Palette = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const plain: Palette = {
  bold: (s) => s,
  dim: (s) => s,
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  cyan: (s) => s,
};

function confidenceBar(c: number): string {
  const filled = Math.round(c * 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${(c * 100).toFixed(0)}%`;
}

export function renderText(envelope: Envelope, opts: { color?: boolean; verbose?: boolean } = {}): string {
  const p = opts.color ? colorized : plain;
  const lines: string[] = [];
  const e = envelope;

  // Header
  const phase =
    e.status.phase === "apply"
      ? "on-chain (apply)"
      : e.status.phase === "simulation"
        ? "simulation"
        : e.status.phase === "submission"
          ? "submission (rejected before inclusion)"
          : "unknown phase";
  lines.push(
    p.bold(`soroban-diagnose`) +
      p.dim(` · ${e.network} · protocol ${e.protocol_version ?? "?"} · ${phase}`),
  );

  if (e.status.successful) {
    lines.push(p.green("✓ This input is not a failure — nothing to diagnose."));
    return lines.join("\n");
  }

  // Status line
  const statusBits: string[] = [];
  if (e.status.tx) statusBits.push(`tx: ${e.status.tx}`);
  if (e.status.op) statusBits.push(`op: ${e.status.op}`);
  if (statusBits.length) lines.push(p.dim(statusBits.join("  ·  ")));

  // Error identity
  if (e.error.raw) {
    let errLine = `${p.red("✗")} ${p.bold(e.error.raw)}`;
    const ce = e.error.contract_error;
    if (ce?.name) {
      errLine += ` = ${p.bold(`${ce.enum_name ? ce.enum_name + "." : ""}${ce.name}`)} ${p.dim(`(via ${ce.resolved_from})`)}`;
    } else if (ce) {
      errLine += p.dim(" (code could not be resolved to a name)");
    }
    lines.push(errLine);
    if (ce?.doc) lines.push(`  ${p.dim(ce.doc)}`);
    if (e.error.id) lines.push(p.dim(`  id: ${e.error.id}  ·  layer: ${e.error.layer}`));
  }

  const t = e.transaction;
  if (t?.invocation?.function_name) {
    lines.push(
      p.dim(
        `  call: ${t.invocation.contract_id ?? "?"}.${t.invocation.function_name}(${t.invocation.args.map((a) => JSON.stringify(a)).join(", ").slice(0, 120)})`,
      ),
    );
  }
  if (t?.hash) lines.push(p.dim(`  tx: ${t.hash}${t.ledger ? ` @ ledger ${t.ledger}` : ""}`));

  // Diagnoses
  if (e.diagnoses.length > 0) {
    lines.push("");
    lines.push(p.bold("Probable causes"));
    e.diagnoses.forEach((d, i) => {
      lines.push(
        `${i + 1}. ${p.bold(d.cause_id)}  ${p.cyan(confidenceBar(d.confidence))}${d.confirmed ? p.green("  confirmed") : p.yellow("  unconfirmed")}`,
      );
      lines.push(indent(wrap(d.explanation, 96), 3));
      const shown = d.evidence.filter((ev) => opts.verbose || ev.outcome !== "info");
      for (const ev of shown.slice(0, opts.verbose ? 99 : 4)) {
        const mark =
          ev.outcome === "confirmed" ? p.green("●") : ev.outcome === "refuted" ? p.red("●") : p.dim("○");
        lines.push(indent(`${mark} ${ev.detail ?? ev.type}${ev.key ? p.dim(` [${ev.key}]`) : ""}`, 3));
      }
      if (d.fix) {
        lines.push(indent(p.bold("fix: ") + wrap(d.fix.summary, 90).replace(/\n/g, "\n        "), 3));
        for (const c of d.fix.commands) lines.push(indent(p.cyan(`$ ${c}`), 5));
      }
      for (const v of d.verify) lines.push(indent(p.dim(`verify: ${v}`), 5));
      lines.push("");
    });
  } else {
    lines.push("");
    lines.push(
      p.yellow(
        e.error.layer
          ? "No rule matched — unresolved. The extracted layers are still shown below."
          : "No failure information could be extracted — see the notes below.",
      ),
    );
    lines.push("");
  }

  // Eliminated (verbose only)
  if (opts.verbose && e.eliminated.length > 0) {
    lines.push(p.bold("Eliminated hypotheses"));
    for (const el of e.eliminated) {
      const refuting = el.evidence.find((ev) => ev.outcome === "refuted");
      lines.push(`  ${p.dim("✗")} ${el.cause_id}${refuting?.detail ? p.dim(` — ${refuting.detail}`) : ""}`);
    }
    lines.push("");
  }

  // Diagnostic events
  const events = e.diagnostic_events;
  if (events.length > 0) {
    lines.push(p.bold(`Diagnostic events`) + p.dim(` (${events.length})`));
    const show = opts.verbose ? events : events.slice(0, 8);
    for (const ev of show) {
      const topics = ev.topics.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
      const data =
        ev.data === null || ev.data === undefined
          ? ""
          : ` → ${JSON.stringify(ev.data)}`.slice(0, 160);
      lines.push(p.dim(`  [${topics}]${data}`));
    }
    if (!opts.verbose && events.length > 8) lines.push(p.dim(`  … ${events.length - 8} more (use --verbose)`));
    lines.push("");
  }

  // Unresolved notes
  if (e.unresolved.length > 0) {
    lines.push(p.bold("Notes"));
    for (const u of e.unresolved) lines.push(p.yellow(`  ⚠ ${u.detail}`));
    lines.push("");
  }

  if (e.references.length > 0) {
    lines.push(p.dim("References:"));
    for (const r of e.references.slice(0, opts.verbose ? 10 : 3)) lines.push(p.dim(`  ${r}`));
  }

  return lines.join("\n");
}

function wrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out.join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
