---
name: soroban-diagnose
description: Diagnose failed Soroban transactions and simulations deterministically. Use when a Stellar/Soroban transaction failed, a simulation returned an error, the user pastes an opaque code like Error(Contract, #7), txFAILED, INVOKE_HOST_FUNCTION_TRAPPED, HostError, "entry archived", "resource limit exceeded", "signature has expired", or asks "why did my Soroban transaction fail". Turns a tx hash, simulateTransaction response, or raw XDR into ranked root causes with on-chain evidence and fix commands.
---

# Diagnosing failed Soroban transactions

This skill wraps `soroban-diagnose`, a deterministic (no-LLM) resolver that
turns a failed transaction/simulation into one normalized diagnosis envelope:
the error at each of the five layers, ranked probable causes with **evidence
from live ledger state**, and concrete fix + verify commands.

## Decision tree

1. **You have a transaction hash** (64 hex chars):
   ```sh
   soroban-diagnose tx <hash> --network <testnet|mainnet|futurenet> 
   ```
2. **You have a `simulateTransaction` response** (JSON): save it to a file and
   pass the transaction you simulated too — it unlocks state-lookup evidence:
   ```sh
   soroban-diagnose sim --file sim.json --request-xdr <envelope-b64> --network testnet
   ```
3. **You have raw base64 XDR** (a `TransactionResult` from a sendTransaction
   ERROR, a `TransactionEnvelope`, `TransactionMeta`, or a `DiagnosticEvent`):
   ```sh
   soroban-diagnose xdr <base64> --network testnet
   ```
4. **You only need a contract error code decoded** (`Error(Contract, #N)`):
   ```sh
   soroban-diagnose resolve-error <C...contract-id> <N> --network testnet
   ```

Prefer the MCP server when it is registered (`soroban-diagnose-mcp`): call the
`diagnose_failure` tool with the same inputs, or `resolve_contract_error` for
bare codes. Default responses are compact (~1k tokens); pass `verbose: true`
only when the compact evidence is insufficient.

## Reading the envelope

- `error.id` — stable namespaced identity (`soroban.contract.error`,
  `soroban.host.budget.exceeded_limit`, `tx.bad_seq`); match on this, not on
  prose.
- `error.contract_error.name` — `Error(Contract, #7)` resolved to its enum
  variant via the deployed wasm's spec. `resolved_from: null` means it
  genuinely cannot be named (no spec / out of range) — do not invent a name.
- `diagnoses[]` — ranked causes. `confirmed: true` means a state lookup
  verified the hypothesis; confidence ≤ 0.5 means unverified hypothesis.
  Relay the top cause's `explanation`, `fix.summary`, and `fix.commands` to
  the user; mention runner-ups only if the top is unconfirmed.
- `unresolved[]` — honest gaps (no rule matched, missing diagnostics, RPC
  unavailable). If diagnoses is empty, report the extracted layers and the
  unresolved reasons instead of guessing.

## Interpretation cheat-sheet (from real mainnet data)

- `Storage.ExceededLimit` + "outside of the footprint" → stale simulation:
  state changed between simulate and submit. Fix: re-simulate immediately
  before submitting; never edit args after assembling.
- `Auth.InvalidAction` + "Unauthorized function call for address" → the signed
  authorization does not match the actual invocation (args changed, wrong
  signer, or missing entry).
- `Auth.InvalidInput` + "signature has expired" → re-sign with a fresh
  `signatureExpirationLedger`.
- `WasmVm.InvalidAction` trap → contract panic **or** wrong argument type;
  check args against `stellar contract info interface` first.
- Most wild failures arrive fee-bump-wrapped; the tool unwraps automatically
  and reports the inner transaction.

## Guardrails

- The tool is read-only and needs no keys; never pass secrets to it.
- Do not second-guess a `confirmed` diagnosis with speculation; the evidence
  entries cite the RPC lookups behind it.
- If the tool says `unresolved`, say so to the user — an honest "could not
  attribute" beats a plausible guess.
