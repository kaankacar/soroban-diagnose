/** DEV-ONLY: dump full diagnostic facts for named manifest entries. */
import { readFileSync } from "node:fs";
import { RpcSession, HttpTransport } from "../src/rpc.js";
import { ingest } from "../src/ingest.js";
import type { DiagnoseInput } from "../src/types.js";

const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Array<{
  name: string;
  kind: string;
  hash?: string;
  simResponse?: unknown;
}>;
const wanted = new Set(process.argv.slice(3));

const session = new RpcSession(new HttpTransport("https://soroban-testnet.stellar.org"), 100);

for (const entry of manifest) {
  if (!wanted.has(entry.name)) continue;
  const input: DiagnoseInput =
    entry.kind === "tx"
      ? { kind: "tx_hash", hash: entry.hash! }
      : { kind: "simulation", response: entry.simResponse, ref: entry.name };
  const raw = await ingest(session, input);
  console.log(`\n===== ${entry.name} =====`);
  console.log("sim_error:", raw.sim_error?.slice(0, 500) ?? "-");
  for (const e of raw.facts.errors) {
    console.log(`ERROR ev: Error(${e.error.type}, ${e.error.code}) msg="${e.message}" args=${JSON.stringify(e.args).slice(0, 200)} contract=${e.contract_id}`);
  }
  for (const v of raw.facts.views.slice(0, 25)) {
    console.log(`  view [${v.topics.map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join(", ")}] -> ${JSON.stringify(v.data)?.slice(0, 160)}`);
  }
  console.log("auth entries:", JSON.stringify(raw.tx_context?.auth ?? []));
}
