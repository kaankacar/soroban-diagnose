#!/usr/bin/env node
/**
 * soroban-diagnose CLI.
 *
 *   soroban-diagnose tx <hash> --network testnet
 *   soroban-diagnose sim --file simulation.json
 *   soroban-diagnose xdr <base64>
 *   soroban-diagnose resolve-error <contract-id> <code>
 *
 * Output: JSON (default, compact) | --text | --verbose (full envelope).
 * --narrate appends model-written prose WITHOUT altering structured output.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { diagnose } from "./index.js";
import type { DiagnoseInput, DiagnoseOptions, Envelope } from "./types.js";
import { HttpTransport, NETWORK_RPC, RpcSession } from "./rpc.js";
import { resolveContractError } from "./decode/spec.js";
import { compactEnvelope } from "./render/compact.js";
import { renderText } from "./render/text.js";

interface CommonFlags {
  network: string;
  rpcUrl?: string;
  rules?: string;
  text?: boolean;
  json?: boolean;
  verbose?: boolean;
  narrate?: boolean;
}

function diagnoseOptions(flags: CommonFlags): DiagnoseOptions {
  return {
    network: flags.network,
    rpcUrl: flags.rpcUrl,
    rulesPath: flags.rules,
    verbose: flags.verbose,
  };
}

async function emit(envelope: Envelope, flags: CommonFlags): Promise<void> {
  const view = flags.verbose ? envelope : compactEnvelope(envelope);
  if (flags.text) {
    process.stdout.write(
      renderText(view, { color: process.stdout.isTTY, verbose: flags.verbose }) + "\n",
    );
  } else {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n");
  }
  if (flags.narrate) {
    try {
      const { narrate } = await import("./narrate.js");
      const prose = await narrate(envelope);
      process.stderr.write("\n--- narration (model-generated, not part of the diagnosis) ---\n");
      process.stderr.write(prose + "\n");
    } catch (e) {
      process.stderr.write(`\nnarration failed: ${(e as Error).message}\n`);
    }
  }
  // Exit code contract: 0 diagnosed or successful, 2 unresolved, 1 hard error.
  if (!envelope.status.successful && envelope.diagnoses.length === 0) {
    process.exitCode = 2;
  }
}

function addCommonFlags(cmd: Command): Command {
  return cmd
    .option("-n, --network <name>", "testnet | mainnet | futurenet | local", "testnet")
    .option("--rpc-url <url>", "explicit RPC URL (overrides --network)")
    .option("--rules <path>", "path to a rules YAML file")
    .option("--json", "JSON output (default)")
    .option("--text", "human-readable output")
    .option("-v, --verbose", "full envelope: all events, evidence, eliminated hypotheses")
    .option("--narrate", "append model-written prose (requires ANTHROPIC_API_KEY; never alters structured output)");
}

const program = new Command();
program
  .name("soroban-diagnose")
  .description("Deterministic failure diagnosis for Soroban transactions and simulations")
  .version("0.1.0");

addCommonFlags(
  program
    .command("tx")
    .description("diagnose a failed transaction by hash")
    .argument("<hash>", "transaction hash (hex)"),
).action(async (hash: string, flags: CommonFlags) => {
  const input: DiagnoseInput = { kind: "tx_hash", hash: hash.trim().toLowerCase() };
  await emit(await diagnose(input, diagnoseOptions(flags)), flags);
});

addCommonFlags(
  program
    .command("sim")
    .description("diagnose a simulateTransaction response (JSON)")
    .option("--file <path>", "path to the JSON file (defaults to stdin)")
    .option(
      "--request-xdr <base64>",
      "the simulated TransactionEnvelope XDR; enables invocation context and state checks",
    ),
).action(async (flags: CommonFlags & { file?: string; requestXdr?: string }) => {
  const raw = flags.file ? readFileSync(flags.file, "utf8") : readFileSync(0, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`input is not valid JSON: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const input: DiagnoseInput = {
    kind: "simulation",
    response: parsed,
    request_xdr: flags.requestXdr,
    ref: flags.file ?? "stdin",
  };
  await emit(await diagnose(input, diagnoseOptions(flags)), flags);
});

addCommonFlags(
  program
    .command("xdr")
    .description("diagnose raw base64 XDR (TransactionResult, TransactionEnvelope, TransactionMeta, or DiagnosticEvent)")
    .argument("[base64]", "base64 XDR (defaults to stdin)"),
).action(async (base64: string | undefined, flags: CommonFlags) => {
  const raw = (base64 ?? readFileSync(0, "utf8")).trim();
  const input: DiagnoseInput = { kind: "xdr", base64: raw };
  await emit(await diagnose(input, diagnoseOptions(flags)), flags);
});

program
  .command("resolve-error")
  .description("resolve a contract error code to its enum name via contractspecv0")
  .argument("<contract-id>", "C... contract address")
  .argument("<code>", "numeric error code")
  .option("-n, --network <name>", "testnet | mainnet | futurenet | local", "testnet")
  .option("--rpc-url <url>", "explicit RPC URL")
  .action(async (contractId: string, codeStr: string, flags: { network: string; rpcUrl?: string }) => {
    const code = Number(codeStr);
    if (!Number.isInteger(code) || code < 0) {
      process.stderr.write(`"${codeStr}" is not a valid non-negative integer error code\n`);
      process.exitCode = 1;
      return;
    }
    const url = flags.rpcUrl ?? NETWORK_RPC[flags.network];
    if (!url) {
      process.stderr.write(`unknown network "${flags.network}" and no --rpc-url given\n`);
      process.exitCode = 1;
      return;
    }
    const session = new RpcSession(new HttpTransport(url));
    const res = await resolveContractError(session, contractId, code);
    process.stdout.write(
      JSON.stringify(
        res.ok
          ? { resolved: true, ...res.info, ambiguous_with: res.ambiguous_with }
          : { resolved: false, reason: res.reason, detail: res.detail, ...res.info },
        null,
        2,
      ) + "\n",
    );
    if (!res.ok) process.exitCode = 2;
  });

program.parseAsync().catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
