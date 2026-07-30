/**
 * Optional prose synthesis — the ONLY place a model appears, strictly outside
 * the resolution path. Guarantees:
 *   - opt-in only (--narrate / narrate: true), off by default
 *   - requires the caller's own Anthropic credentials (env)
 *   - consumes the finished envelope; can never alter structured output
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Envelope } from "./types.js";
import { compactEnvelope } from "./render/compact.js";

const SYSTEM = `You explain failed Stellar/Soroban transactions to developers.
You are given a machine-produced diagnosis envelope (JSON). It already contains
the ranked probable causes with evidence and fixes — your job is only to
narrate it, not to re-diagnose. Do not invent causes, confidences, or commands
that are not in the envelope. If the envelope says unresolved, say so plainly.
Write 3-6 sentences of plain prose for a developer: what failed, why (per the
top diagnosis), and what to do next. No headers, no lists, no code fences.`;

export async function narrate(envelope: Envelope): Promise<string> {
  const client = new Anthropic();
  const payload = JSON.stringify(compactEnvelope(envelope));
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2048, // deliberately short output: a few sentences of prose
    system: SYSTEM,
    messages: [{ role: "user", content: payload }],
  });
  if (response.stop_reason === "refusal") {
    return "(narration unavailable: the model declined this request)";
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || "(narration unavailable: empty response)";
}
