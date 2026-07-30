/** DEV-ONLY: run every manifest entry through diagnose() live and compare with expectations. */
import { readFileSync } from "node:fs";
import { diagnose } from "../src/index.js";
import type { DiagnoseInput, Envelope } from "../src/types.js";

const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Array<{
  name: string;
  kind: "tx" | "send_error" | "sim";
  hash?: string;
  sendResponse?: { errorResultXdr?: string };
  simResponse?: unknown;
  expected: string;
  error?: string;
}>;

let pass = 0;
for (const entry of manifest) {
  if (entry.error) {
    console.log(`SKIP ${entry.name} (generator failed)`);
    continue;
  }
  let input: DiagnoseInput;
  if (entry.kind === "tx" && entry.hash) {
    input = { kind: "tx_hash", hash: entry.hash };
  } else if (entry.kind === "send_error" && entry.sendResponse?.errorResultXdr) {
    input = { kind: "xdr", base64: entry.sendResponse.errorResultXdr };
  } else if (entry.kind === "sim" && entry.simResponse) {
    input = { kind: "simulation", response: entry.simResponse, ref: entry.name };
  } else {
    console.log(`SKIP ${entry.name} (no usable input)`);
    continue;
  }
  let env: Envelope;
  try {
    env = await diagnose(input, { network: "testnet" });
  } catch (e) {
    console.log(`ERR  ${entry.name}: ${(e as Error).message}`);
    continue;
  }
  const top = env.diagnoses[0];
  const causes = env.diagnoses.map((d) => `${d.cause_id}@${d.confidence}${d.confirmed ? "✓" : "?"}`).join(", ");
  const errId = env.error.id ?? "-";
  const name = env.error.contract_error?.name ? ` [${env.error.contract_error.name}]` : "";
  console.log(`${top ? "OK " : "UNRESOLVED"} ${entry.name}`);
  console.log(`     expected=${entry.expected}  error_id=${errId}${name}`);
  console.log(`     diagnoses: ${causes || "(none)"}`);
  if (top) pass++;
}
console.log(`\n${pass}/${manifest.length} produced at least one diagnosis`);
