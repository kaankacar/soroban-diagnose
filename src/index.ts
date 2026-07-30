/**
 * soroban-diagnose library API.
 *
 * `diagnose()` is the whole product: input in, one normalized envelope out.
 * Deterministic end to end — no model anywhere in this path.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DiagnoseInput, DiagnoseOptions, Envelope } from "./types.js";
import { HttpTransport, NETWORK_RPC, RpcSession } from "./rpc.js";
import { ingest } from "./ingest.js";
import { normalize } from "./normalize.js";
import { loadRuleTable, type RuleTable } from "./resolve/ruleschema.js";
import { resolveDiagnoses } from "./resolve/engine.js";

export * from "./types.js";
export {
  HttpTransport,
  RecordingTransport,
  ReplayTransport,
  RpcSession,
  NETWORK_RPC,
  type RecordedCall,
} from "./rpc.js";
export { loadRuleTable, validateRuleTable, type Rule, type RuleTable } from "./resolve/ruleschema.js";
export { resolveContractError, SAC_ERRORS, type Resolution } from "./decode/spec.js";
export { compactEnvelope } from "./render/compact.js";
export { renderText } from "./render/text.js";
export { estimateTokens } from "./render/tokens.js";

const DEFAULT_RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "rules.yaml");
const DEFAULT_DOC =
  "https://developers.stellar.org/docs/learn/fundamentals/contract-development/errors-and-debugging/debugging-errors";

let cachedTable: { path: string; table: RuleTable } | null = null;

function tableFor(path: string): RuleTable {
  if (cachedTable && cachedTable.path === path) return cachedTable.table;
  const table = loadRuleTable(path);
  cachedTable = { path, table };
  return table;
}

export function defaultRulesPath(): string {
  return DEFAULT_RULES_PATH;
}

export async function diagnose(
  input: DiagnoseInput,
  options: DiagnoseOptions = {},
): Promise<Envelope> {
  let transport = options.transport ?? null;
  if (!transport) {
    const url = options.rpcUrl ?? NETWORK_RPC[options.network ?? "testnet"];
    if (url) transport = new HttpTransport(url);
  }
  const session = transport ? new RpcSession(transport, options.maxLookups ?? 30) : null;

  const raw = await ingest(session, input);
  const { envelope } = await normalize(session, raw);

  const table = tableFor(options.rulesPath ?? DEFAULT_RULES_PATH);
  const { diagnoses, eliminated } = await resolveDiagnoses(session, table, envelope, raw);
  envelope.diagnoses = diagnoses;
  envelope.eliminated = eliminated;

  if (diagnoses.length === 0 && !envelope.status.successful && envelope.error.layer !== null) {
    envelope.unresolved.push({
      reason: "no_rule_matched",
      detail: `No rule in table matched ${envelope.error.id ?? envelope.error.raw ?? "this failure"}. The normalized envelope above still carries every extracted layer.`,
    });
  }

  const refs = new Set<string>();
  for (const d of diagnoses) for (const r of d.references) refs.add(r);
  refs.add(DEFAULT_DOC);
  envelope.references = [...refs].slice(0, 6);

  return envelope;
}
