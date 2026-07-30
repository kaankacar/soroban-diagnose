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

## Design constraints (the point of the architecture)

1. **No LLM anywhere in the resolution path.** Cause ranking, confidence, and
   fix commands come from a deterministic rule table plus state lookups. The
   same input and ledger state always produce byte-identical output, which is
   what makes the tool testable against a fixed corpus. An optional
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

## Install & use

```sh
npm install
npm run build

# CLI
soroban-diagnose tx <hash> --network testnet          # JSON (compact) by default
soroban-diagnose tx <hash> --text --verbose           # human view, all evidence
soroban-diagnose sim --file sim.json --request-xdr <b64>   # simulation + its envelope
soroban-diagnose xdr <base64>                         # TransactionResult / Envelope / Meta / DiagnosticEvent
soroban-diagnose resolve-error <contract-id> <code>   # just the name resolution

# exit codes: 0 = diagnosed (or input wasn't a failure), 2 = unresolved, 1 = hard error
```

Passing `--request-xdr` with a simulation unlocks invocation context (function,
args, auth) and therefore the state-lookup checks — without it, a simulation
response alone still yields the host/contract layers.

### MCP server

```sh
soroban-diagnose-mcp    # stdio transport
```

Exposes exactly two tools:

- `diagnose_failure(input, network, request_xdr?, verbose?)` — accepts a tx
  hash, a simulation-response JSON string, or base64 XDR; returns the envelope.
- `resolve_contract_error(contract_id, code, network)` — returns the enum
  variant name, doc, and provenance, or `resolved: false` with the reason.

Default responses are compacted to stay under ~1,500 tokens (an agent calling
this tool is spending its own context); `verbose: true` returns everything.

Claude Code registration:

```sh
claude mcp add soroban-diagnose -- node /path/to/soroban-diagnose/dist/mcp.js
```

### Library

```ts
import { diagnose } from "soroban-diagnose";
const envelope = await diagnose({ kind: "tx_hash", hash: "..." }, { network: "testnet" });
```

All RPC goes through a two-method transport interface, so tests inject a
`ReplayTransport` and run fully offline.

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

Everything runs offline. `fixtures/` holds 30+ **real failures** — produced
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
deterministic-path latency floors. CI runs both on every push.

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
FINDINGS.md        what turned out to be hard — read this before scoping the RFP
```

## License

Apache-2.0. Built on `@stellar/stellar-sdk` for all XDR handling.
