#!/usr/bin/env node
/**
 * soroban-diagnose MCP server (stdio).
 *
 * Exposes exactly two tools:
 *   - diagnose_failure(input, network, verbose?) -> diagnosis envelope
 *   - resolve_contract_error(contract_id, code, network) -> enum variant name
 *
 * Design constraint: an agent calling these tools is spending its own
 * context. Default responses are compacted to stay under ~1,500 tokens;
 * `verbose: true` returns the full envelope with all evidence.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diagnose } from "./index.js";
import type { DiagnoseInput } from "./types.js";
import { HttpTransport, NETWORK_RPC, RpcSession } from "./rpc.js";
import { resolveContractError } from "./decode/spec.js";
import { compactEnvelope } from "./render/compact.js";

const networkSchema = z
  .enum(["testnet", "mainnet", "futurenet", "local"])
  .describe("Stellar network the input belongs to");

const server = new McpServer({
  name: "soroban-diagnose",
  version: "0.1.0",
});

server.registerTool(
  "diagnose_failure",
  {
    title: "Diagnose a failed Soroban transaction or simulation",
    description:
      "Turn a failed Soroban transaction hash, a simulateTransaction response (JSON string), or raw base64 XDR into a structured diagnosis: what failed, at which layer, ranked probable root causes with on-chain evidence, and concrete fix commands. Deterministic — no model involved. Returns machine-readable JSON; `unresolved` entries mean the tool could not attribute the failure (it never guesses).",
    inputSchema: {
      input: z
        .string()
        .describe(
          "One of: a 64-char hex transaction hash; a simulateTransaction response as a JSON string; or base64 XDR (TransactionResult, TransactionEnvelope, TransactionMeta, or DiagnosticEvent).",
        ),
      network: networkSchema,
      rpc_url: z.string().url().optional().describe("Custom RPC URL (overrides network default)"),
      request_xdr: z
        .string()
        .optional()
        .describe(
          "When input is a simulation response: the simulated TransactionEnvelope XDR (base64). Enables invocation context and state-lookup evidence.",
        ),
      verbose: z
        .boolean()
        .optional()
        .describe("Return the full envelope with all diagnostic events and evidence (larger)"),
    },
  },
  async ({ input, network, rpc_url, request_xdr, verbose }) => {
    const trimmed = input.trim();
    let parsed: DiagnoseInput;
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      parsed = { kind: "tx_hash", hash: trimmed.toLowerCase() };
    } else if (trimmed.startsWith("{")) {
      try {
        parsed = { kind: "simulation", response: JSON.parse(trimmed), request_xdr, ref: "mcp" };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "input_invalid",
                reason: `Input looks like JSON but failed to parse: ${(e as Error).message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    } else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 8) {
      parsed = { kind: "xdr", base64: trimmed };
    } else {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "input_invalid",
              reason:
                "Input is not a 64-char hex tx hash, a JSON simulation response, or base64 XDR.",
            }),
          },
        ],
        isError: true,
      };
    }

    const envelope = await diagnose(parsed, { network, rpcUrl: rpc_url });
    const view = verbose ? envelope : compactEnvelope(envelope);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(view) }],
    };
  },
);

server.registerTool(
  "resolve_contract_error",
  {
    title: "Resolve a Soroban contract error code to its name",
    description:
      "Map Error(Contract, #N) to its enum variant name by fetching the deployed contract's wasm and parsing the contractspecv0 section (or the built-in Stellar Asset Contract table). Never guesses: when the wasm has no spec or the code is out of range, returns resolved: false with the reason.",
    inputSchema: {
      contract_id: z.string().regex(/^C[A-Z2-7]{55}$/, "must be a C... contract address"),
      code: z.number().int().nonnegative().describe("numeric contract error code"),
      network: networkSchema,
      rpc_url: z.string().url().optional().describe("Custom RPC URL (overrides network default)"),
    },
  },
  async ({ contract_id, code, network, rpc_url }) => {
    const url = rpc_url ?? NETWORK_RPC[network];
    const session = new RpcSession(new HttpTransport(url!));
    const res = await resolveContractError(session, contract_id, code);
    const body = res.ok
      ? { resolved: true, ...res.info, ambiguous_with: res.ambiguous_with }
      : { resolved: false, reason: res.reason, detail: res.detail, ...res.info };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(body) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
