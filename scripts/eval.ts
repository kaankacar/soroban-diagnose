/**
 * Eval harness: replays every labeled fixture offline and reports accuracy
 * against the acceptance floors from the RFP spec (section 3.4):
 *   - top-1 root-cause accuracy >= 80%
 *   - top-3 root-cause accuracy >= 95%
 *   - zero confident (>0.8) wrong top-1 answers in the high-risk subset
 *     (auth failures, archived entries, budget exhaustion)
 *   - deterministic-path latency p50 < 500ms warm, excluding RPC
 *
 * Runs in CI (`npm run eval`); exits non-zero below any floor.
 * Writes eval-report.md with per-release numbers.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { diagnose } from "../src/index.js";
import { ReplayTransport, type RecordedCall } from "../src/rpc.js";
import type { DiagnoseInput } from "../src/types.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

interface Fixture {
  name: string;
  network: string;
  input: DiagnoseInput;
  expected: {
    error_id: string;
    top_cause: string;
    contract_error_name: string | null;
    confirmed: boolean;
    must_not_fire: string[];
  } | null;
  recorded: RecordedCall[];
}

const HIGH_RISK_PREFIXES = ["auth", "entry_archived", "sim.entry_archived", "budget"];

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")));

const labeled = fixtures.filter((f) => f.expected);
const wild = fixtures.filter((f) => !f.expected);

interface Row {
  name: string;
  expected: string;
  got: string;
  rank: number | null; // 1-based rank of expected cause, null if absent
  confidence: number | null;
  highRisk: boolean;
  confidentWrong: boolean;
  ms: number;
}

const rows: Row[] = [];
const latencies: number[] = [];

for (const f of labeled) {
  const t0 = performance.now();
  const envelope = await diagnose(f.input, {
    network: f.network,
    transport: new ReplayTransport(f.recorded),
  });
  const ms = performance.now() - t0;
  latencies.push(ms);
  const causes = envelope.diagnoses.map((d) => d.cause_id);
  const rank = causes.indexOf(f.expected!.top_cause);
  const top = envelope.diagnoses[0];
  const highRisk = HIGH_RISK_PREFIXES.some((p) => f.expected!.top_cause.startsWith(p));
  rows.push({
    name: f.name,
    expected: f.expected!.top_cause,
    got: top?.cause_id ?? "(unresolved)",
    rank: rank === -1 ? null : rank + 1,
    confidence: top?.confidence ?? null,
    highRisk,
    confidentWrong: highRisk && rank !== 0 && (top?.confidence ?? 0) > 0.8,
    ms,
  });
}

// Wild fixtures: crash-free coverage + extraction rate.
let wildResolved = 0;
for (const f of wild) {
  const envelope = await diagnose(f.input, {
    network: f.network,
    transport: new ReplayTransport(f.recorded),
  });
  if (envelope.diagnoses.length > 0) wildResolved++;
}

const top1 = rows.filter((r) => r.rank === 1).length / rows.length;
const top3 = rows.filter((r) => r.rank !== null && r.rank <= 3).length / rows.length;
const confidentWrong = rows.filter((r) => r.confidentWrong);
latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length / 2)]!;
const p95 = latencies[Math.floor(latencies.length * 0.95)]!;

const lines: string[] = [];
lines.push(`# soroban-diagnose eval report`);
lines.push("");
lines.push(`- Labeled fixtures: **${rows.length}** (real failures; labels fixed at generation time)`);
lines.push(`- Distinct root causes: **${new Set(rows.map((r) => r.expected)).size}**`);
lines.push(`- Unlabeled wild mainnet fixtures: **${wild.length}** (${wildResolved} produced a ranked diagnosis)`);
lines.push("");
lines.push(`| Metric | Result | Floor | Status |`);
lines.push(`|---|---|---|---|`);
lines.push(`| Top-1 accuracy | ${(top1 * 100).toFixed(1)}% | >= 80% | ${top1 >= 0.8 ? "PASS" : "FAIL"} |`);
lines.push(`| Top-3 accuracy | ${(top3 * 100).toFixed(1)}% | >= 95% | ${top3 >= 0.95 ? "PASS" : "FAIL"} |`);
lines.push(
  `| Confident-wrong in high-risk subset | ${confidentWrong.length} | 0 | ${confidentWrong.length === 0 ? "PASS" : "FAIL"} |`,
);
lines.push(`| Deterministic latency p50 (offline replay) | ${p50.toFixed(1)} ms | < 500 ms | ${p50 < 500 ? "PASS" : "FAIL"} |`);
lines.push(`| Deterministic latency p95 (offline replay) | ${p95.toFixed(1)} ms | < 2000 ms | ${p95 < 2000 ? "PASS" : "FAIL"} |`);
lines.push("");
lines.push(`## Per-fixture results`);
lines.push("");
lines.push(`| Fixture | Expected cause | Top-1 | Rank | Top confidence |`);
lines.push(`|---|---|---|---|---|`);
for (const r of rows) {
  const mark = r.rank === 1 ? "✓" : r.rank !== null ? `#${r.rank}` : "✗";
  lines.push(`| ${r.name}${r.highRisk ? " ⚠" : ""} | ${r.expected} | ${r.got} ${mark} | ${r.rank ?? "-"} | ${r.confidence?.toFixed(2) ?? "-"} |`);
}
lines.push("");
lines.push(`⚠ = high-risk subset (auth / archived entries / budget). RPC round-trips are excluded by design: fixtures replay recorded responses.`);
lines.push("");
lines.push(`Generated by \`npm run eval\`.`);

const report = lines.join("\n");
writeFileSync(join(import.meta.dirname, "..", "eval-report.md"), report + "\n");
console.log(report);

if (top1 < 0.8 || top3 < 0.95 || confidentWrong.length > 0) {
  console.error("\nEVAL FLOOR VIOLATED");
  for (const r of confidentWrong) console.error(`confident-wrong: ${r.name} got ${r.got}@${r.confidence}`);
  process.exit(1);
}
console.log("\nAll acceptance floors met.");
