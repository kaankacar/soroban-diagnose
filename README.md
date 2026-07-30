# soroban-diagnose

Deterministic failure diagnosis for Soroban transactions and simulations.

Give it a failed transaction hash, a `simulateTransaction` response, or raw
XDR — get back **one normalized, machine-readable diagnosis**: what failed, at
which of the five error layers, the probable root causes ranked by confidence,
the on-chain **evidence** behind each hypothesis, and a concrete **fix** with a
command to verify it.

```
$ soroban-diagnose tx fc5a57ea…daf22e --network testnet --text

soroban-diagnose · testnet · protocol 27 · on-chain (apply)
tx: txFAILED  ·  op: INVOKE_HOST_FUNCTION_TRAPPED
✗ Error(Contract, #1) = ChaosError.InsufficientBalance (via contractspecv0)
  The caller's balance is too low for the requested operation.

Probable causes
1. contract_error_resolved  █████████░ 90%  confirmed
   ...
```

The headline transformation: `Error(Contract, #7)` is opaque until you fetch
the deployed wasm, parse its `contractspecv0` custom section, and map code 7
back to its enum variant name — including the doc comment the contract author
wrote. This tool does that mechanically, for custom contracts and for the
built-in Stellar Asset Contract, and **never guesses**: when the wasm has no
spec or the code is out of range it says so (`resolved_from: null`).

## One engine, three doors

The diagnosis engine is a plain TypeScript library. Everything else is a thin
surface over it — pick the one that matches where you are when a transaction
fails:

| You are… | Use | Entry point |
|---|---|---|
| a developer in a terminal with a failing tx | **CLI** | `soroban-diagnose tx <hash> --text` |
| an AI agent / Claude Code session debugging for you | **MCP server** | `diagnose_failure` tool |
| a service or script that wants to react to failures programmatically | **Library** | `import { diagnose }` |

All three return the same deterministic envelope; the CLI can render it as
human text, the MCP server compacts it for an agent's context budget.

## Setup

```sh
git clone https://github.com/kaankacar/soroban-diagnose
cd soroban-diagnose
npm install
npm run build        # emits dist/  (cli.js, mcp.js, library)
npm link             # optional: makes `soroban-diagnose` and `soroban-diagnose-mcp` global
```

Node ≥ 20. No API keys, no configuration: the tool only reads public chain
state over RPC (defaults: SDF testnet / mainnet endpoints; override with
`--rpc-url`).

## 1. CLI — debugging by hand

There is one subcommand per kind of thing you might be holding when something
fails:

### You have a transaction hash

```sh
soroban-diagnose tx <hash> --network testnet --text
```

Fetches the transaction via RPC, extracts all five error layers, resolves
contract error codes through the deployed wasm's spec, runs the rule table's
state lookups (TTLs, trustlines, balances, network limits, auth expirations),
and prints ranked causes with evidence and a fix. Drop `--text` to get the
JSON envelope instead (for piping into `jq` or scripts); add `--verbose` for
every diagnostic event, the full evidence trail, and the hypotheses that were
checked and **eliminated**.

### You have a failed simulation

Save the `simulateTransaction` response to a file and — important — pass the
transaction you simulated as well:

```sh
soroban-diagnose sim --file sim-response.json --request-xdr <envelope-b64> --network testnet
```

The response alone identifies the host/contract layers; the request envelope
adds the invocation (contract, function, args, auth), which is what lets the
state-lookup checks run and *confirm* hypotheses. Without it you still get an
identity like `soroban.contract.error [TrustlineMissingError]`, but with it
you get "and account `GAUR…` really holds no `CHAOS` trustline, checked at
ledger N".

### You have raw XDR

```sh
soroban-diagnose xdr <base64> --network testnet
```

Auto-detects what you pasted:

| XDR type | Typical source | What you get |
|---|---|---|
| `TransactionResult` | `sendTransaction` ERROR (`errorResultXdr`) | submission-phase diagnosis (`tx.bad_seq`, `tx.too_late`, …) |
| `TransactionEnvelope` | your unsubmitted/failed tx | **live read-only re-simulation** and a full diagnosis of the result |
| `TransactionMeta` | archives, dumps | diagnostic-event extraction |
| `DiagnosticEvent` | logs | single-event decode |

### You just want a code decoded

```sh
soroban-diagnose resolve-error CCF543IP…ZKQ3 7 --network testnet
# → { "resolved": true, "name": "InvalidAmount", "enum_name": "ChaosError",
#     "doc": "The provided amount is invalid.", "resolved_from": "contractspecv0" }
```

### Flags and exit codes

- `--network testnet|mainnet|futurenet|local` (default testnet) or `--rpc-url <url>`
- `--json` (default) / `--text` / `--verbose`
- `--rules <path>` — swap in your own rule table without rebuilding
- `--narrate` — append model-written prose *after* the structured output
  (needs `ANTHROPIC_API_KEY`; never alters the diagnosis)
- exit `0` = diagnosed (or the input wasn't a failure), `2` = unresolved,
  `1` = hard error — safe to branch on in scripts

## 2. MCP server — letting an agent debug

This is the surface the tool was designed around: an agent that debugs
correctly but burns twenty tool calls and ten minutes doing it is a churn
source; this collapses that loop into one call.

Register it once (Claude Code shown; any MCP client works the same way over
stdio):

```sh
claude mcp add soroban-diagnose -- node /absolute/path/to/soroban-diagnose/dist/mcp.js
```

From then on, in any session you can say *"why did transaction fc5a57ea… fail
on testnet?"* and the agent calls:

- **`diagnose_failure(input, network, request_xdr?, verbose?)`** — `input` is
  whatever you have: a 64-hex tx hash, a simulation-response JSON string, or
  base64 XDR. Returns the envelope, compacted to stay under **~1,500 tokens**
  (an agent calling this tool is spending its own context); `verbose: true`
  returns everything.
- **`resolve_contract_error(contract_id, code, network)`** — just the
  `Error(Contract, #N)` → name mapping, or `resolved: false` with the reason.

Two design guarantees matter for agent use: every rejection carries a
machine-readable reason, and `unresolved` is a first-class answer — the tool
tells the agent "I could not attribute this" rather than hallucinating a
cause for it to act on. Stable `cause_id`s and `error.id`s mean the agent can
match on identity instead of parsing prose.

A skill add-on for Claude lives in [`skill/SKILL.md`](skill/SKILL.md) — drop
it into your skills directory to teach the agent when to reach for the tool
and how to read the envelope.

## 3. Library — reacting to failures in code

```ts
import { diagnose } from "soroban-diagnose";

const envelope = await diagnose(
  { kind: "tx_hash", hash: sendResult.hash },
  { network: "mainnet" },
);

// cause_ids are stable identifiers — match on them, not on prose
const top = envelope.diagnoses[0];
if (top?.cause_id === "footprint_access_outside_declared" && top.confirmed) {
  await resimulateAndResubmit(tx);   // the #1 wild failure mode on mainnet
} else if (envelope.error.contract_error?.name) {
  log.error(`contract rejected: ${envelope.error.contract_error.name}`, top?.fix?.summary);
}
```

Other input kinds: `{ kind: "simulation", response, request_xdr? }` and
`{ kind: "xdr", base64 }`. Useful options: `rpcUrl`, `rulesPath`,
`transport` — the latter is a two-method interface all RPC goes through,
which is how the test suite replays recorded fixtures fully offline, and how
you could plug in a caching or historical-state backend.

---

## Design constraints (the point of the architecture)

1. **No LLM anywhere in the resolution path.** Cause ranking, confidence, and
   fix commands come from a deterministic rule table plus state lookups. The
   same input and ledger state always produce byte-identical output, which is
   what makes the tool testable against a fixed corpus. The optional
   `--narrate` flag adds model-written prose *after* the diagnosis exists; it
   can never alter the structured output.
2. **`unresolved` is a valid answer.** "No rule matched, here is the raw
   normalized envelope" is correct behavior. Silent guessing is a failure mode
   this design explicitly screens out: a hypothesis with no confirming state
   lookup is hard-capped at confidence 0.5.
3. **Every diagnosis carries evidence.** Each state check that runs becomes an
   `evidence` entry — whether it confirms, refutes, or was unavailable.
   Refuted hypotheses are eliminated and surfaced under `eliminated`.
4. **Read-only.** The tool never accepts secret keys and never submits
   transactions. Every lookup is a public-state read.
5. **No XDR reimplementation.** All XDR decoding delegates to
   `@stellar/stellar-sdk`; the only binary parsing here is a ~60-line wasm
   *section walker* used to locate the `contractspecv0` payload.

## Architecture

```
input (tx hash | simulation response | raw XDR)
  -> ingest        src/ingest.ts        fetch + decode all five error layers
  -> normalize     src/normalize.ts     emit the canonical envelope (frozen schema)
  -> resolve       src/resolve/         match rules, run state lookups, rank causes
  -> render        src/render/          JSON (default) | text | MCP tool response
```

The five layers, extracted in order and recorded as `null` when absent:

| Layer | Example | Source |
|---|---|---|
| Transaction | `txFAILED`, `txINSUFFICIENT_FEE` | `TransactionResult` XDR |
| Operation | `INVOKE_HOST_FUNCTION_TRAPPED` | operation results |
| Host | `Error(Budget, ExceededLimit)` | diagnostic events / sim error string |
| Contract | `Error(Contract, #7)` → enum name | deployed wasm `contractspecv0` |
| Diagnostic events | messages, call chain, args | tx meta / RPC events field |

The envelope is frozen at `schema_version: "1.0"` and specified in
[`schema/envelope.schema.json`](schema/envelope.schema.json); every output is
validated against it in tests, in both full and compact forms.

## The rule table

Rules are **data**, not code: [`rules/rules.yaml`](rules/rules.yaml) is
versioned independently and updatable without a release (`--rules` flag /
`rulesPath` option). ~45 rules cover the transaction layer (submission
rejections), the operation layer (archived entries, resource limits,
refundable fees), the host layer (budget, auth, storage, VM), the contract
layer (custom contract errors via spec + nine Stellar Asset Contract causes),
and simulation-specific outcomes (`restorePreamble`).

### How to add a rule

```yaml
- id: my_new_cause                  # stable id consumers can match on
  protocol: ">=23"                  # optional protocol range
  match:                            # ALL conditions must hold; lists OR within one
    op_result: INVOKE_HOST_FUNCTION_TRAPPED
    host_error: Storage.MissingValue
    diagnostic_contains: "some real message text"
  checks:                           # state lookups; each emits evidence
    - kind: trustline               # ttl | trustline | account | resource_headroom |
      target: "arg:1"               #   auth_expiration | auth_signature | wasm_spec |
      assert: missing               #   declared_resources | restore_preamble | diagnostic_message
      required: true                # this check discriminates the hypothesis
  confidence: 0.9                   # granted only when confirmed; else capped at 0.5
  explanation: >                    # {placeholders} interpolate from context + checks
    ...
  fix:
    summary: ...
    commands: ["stellar ..."]
  verify: ["stellar ..."]
  references: ["https://developers.stellar.org/..."]
```

Semantics enforced by the engine:

- a rule with one **refuted** check is eliminated entirely (and reported under
  `eliminated`);
- a rule whose checks are all unavailable — or that has none — is capped at
  confidence **0.5**;
- `required: true` marks the check that distinguishes this hypothesis from
  sibling rules (e.g. sender-balance vs receiver-limit for the same
  `BalanceError`);
- `conclusive: true` is reserved for 1:1 result-code causes (`txBAD_SEQ` *is*
  the diagnosis) and is rejected for contract-layer rules.

## Testing & the eval harness

Everything runs offline. `fixtures/` holds 35 **real failures** — produced
deliberately on testnet (contract errors, wasm panics, budget exhaustion,
expired/unsigned/mismatched auth, SAC trustline and balance failures,
submission rejections, fee-bump wrapping) plus wild failures captured from
mainnet — with every RPC exchange recorded for byte-exact replay.

```sh
npm test        # unit + fixture replay + schema validation + negative assertions
npm run eval    # accuracy report vs the acceptance floors, writes eval-report.md
```

The eval harness enforces: top-1 ≥ 80%, top-3 ≥ 95%, zero confident-wrong
answers in the high-risk subset (auth / archived entries / budget), and
deterministic-path latency floors. CI runs both on every push; the current
numbers are in [`eval-report.md`](eval-report.md).

### How to add a fixture

1. Find or produce a real failure (see `scripts/generate-failures*.mts` for
   how the corpus was made — testnet only, never part of the shipped tool).
2. Record it: `npx tsx scripts/record-fixtures.mts <manifest.json>` wraps live
   RPC in a `RecordingTransport` and writes `fixtures/<name>.json`.
3. Label it **from how the failure was constructed**, not from the tool's
   output, and add `must_not_fire` entries for the plausible-but-wrong causes.

## Repository layout

```
src/               resolver core (library, CLI, MCP)
rules/rules.yaml   protocol-versioned rule table (data)
schema/            frozen envelope JSON Schema
fixtures/          recorded real failures (offline replay corpus)
test/              vitest suite
scripts/           dev-only tooling: corpus generation, recording, eval
docs/              worked debugging walkthroughs from real failures
FINDINGS.md        what turned out to be hard — read this before scoping further work
```

## License

Apache-2.0. Built on `@stellar/stellar-sdk` for all XDR handling.
