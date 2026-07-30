# Worked debugging walkthroughs

Three real failures, end to end: the raw signal a developer sees, what the
tool extracts at each layer, how the rule engine reached its diagnosis, and
the fix. The first two are wild mainnet transactions (found by scanning recent
history, not constructed); the third is a real testnet failure whose cause we
know by construction.

---

## 1. Mainnet: `INVOKE_HOST_FUNCTION_TRAPPED` that is really a stale simulation

**Input:** `soroban-diagnose tx 4126449f48a6b362e82e8da3f79f229ece084d2e86db15449e2a1679f9208e9b --network mainnet`

What the developer sees without tooling: `txFAILED`, operation
`INVOKE_HOST_FUNCTION_TRAPPED`. That's it — "trapped" could be anything from a
contract bug to a fee problem.

**Layer extraction:**

- tx: `txFAILED` → op: `INVOKE_HOST_FUNCTION_TRAPPED`
- diagnostic events: `fn_call work(...)`, then an error event
  `Error(Storage, ExceededLimit)` with the message
  *"trying to access contract data key outside of the footprint"*
- host layer identity: `soroban.host.storage.exceeded_limit`

**Resolution:** the `footprint_access_outside_declared` rule matches
(`Storage.ExceededLimit` at apply phase) and its `diagnostic_message` check
confirms against the real event text → confidence 0.9, confirmed.

**Diagnosis:** the transaction's footprint was computed by a simulation that
no longer matched reality when the transaction executed — on-chain state
changed in between (this contract's `work` function walks state that other
transactions mutate constantly). The contract is fine; the submission pipeline
is racing the chain.

**Fix:** re-simulate immediately before submitting and assemble from that
fresh simulation; add retry-on-`Storage.ExceededLimit` with re-simulation in
the submitter.

**Why it matters:** every wild `TRAPPED` mainnet failure we sampled had this
same shape. This single diagnosis covers the plurality of real-world Soroban
failures today.

---

## 2. Mainnet: `RESOURCE_LIMIT_EXCEEDED` with headroom evidence

**Input:** `soroban-diagnose tx 270792c3cc9da6892744d795d0899d4f3d7be12d1cfde290fea4c35ea66ede2c --network mainnet`

**Layer extraction:**

- tx: `txFAILED` → op: `INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED`
- diagnostic events include `Error(Budget, ExceededLimit)` — the host ran out
  of the *declared* CPU budget, not the network's.

**Resolution:** two sibling rules compete here and the state lookup decides:

- `budget_exceeded_declared_too_low` runs the `resource_headroom` check: it
  fetches the network's `ConfigSettingContractComputeV0` ledger entry and
  compares `txMaxInstructions` (400,000,000) against the transaction's
  declared instructions (~18.7M). Declared ≪ cap → **confirmed**: there was
  headroom; the declaration was the binding limit.
- `budget_exceeded_at_network_cap` runs the same lookup with the opposite
  assertion → **refuted**, and is eliminated (visible under `eliminated` in
  verbose output).

**Diagnosis:** the workload needed more instructions than the simulation
predicted — again a simulate/submit drift, this time in CPU rather than
footprint. **Fix:** re-simulate before submitting, or add an instruction
margin when assembling.

Note the evidence discipline: the same observation (declared vs cap) confirms
one hypothesis and eliminates its sibling. Nothing here came from prose — it
is a ledger read anyone can re-run.

---

## 3. Testnet: `Error(Contract, #10)` on a token transfer, with balance proof

**Input:** `soroban-diagnose tx 59723abc3df0daa5b3a1eef3efbc65b0105c458616f5e9e435d8e69f0c8fee05 --network testnet`

This failure was produced the way real users produce it: the transfer was
simulated while the sender had funds, the balance was drained by another
transaction, then the original (still validly signed) transaction was
submitted.

**Layer extraction:**

- tx: `txFAILED` → op: `INVOKE_HOST_FUNCTION_TRAPPED`
- error event: `Error(Contract, #10)` from contract `CBVE…IQLO`

**Contract error resolution:** the tool fetches the contract instance and
finds it is the *built-in Stellar Asset Contract* (executable =
`contractExecutableStellarAsset`), so code 10 resolves through the SAC table:
`BalanceError` — "balance is insufficient, or would exceed limits".

**Resolution:** `BalanceError` is ambiguous (sender balance vs receiver
trustline limit), so the discriminating checks run:

- `sac_balance_insufficient` reads the SAC's instance metadata to identify the
  asset (`CHAOS:GBT6…VBDY`), builds the sender's trustline ledger key, fetches
  it, and compares: balance `100000000` < attempted `300000000` →
  **confirmed** at 0.9.
- `sac_receiver_line_full` tries the receiver side, but the receiver is the
  issuer (issuers hold no trustline) → its required check is unavailable →
  capped at 0.5, unconfirmed, ranked below.

**Diagnosis:** sender has 10 CHAOS, tried to send 30. **Fix:** reduce the
amount or fund the sender; **verify** with the printed `stellar contract
invoke … balance` command.

---

### The common thread

In all three cases the operation result code alone was uninformative
(`TRAPPED` twice, `RESOURCE_LIMIT_EXCEEDED` once). The value came from
correlating the diagnostic-event layer with **live state lookups** — footprint
membership, network limits, trustline balances — and reporting the lookups as
evidence. That correlation is mechanical, deterministic, and cheap (2–7 RPC
calls per diagnosis); there is no reason a developer should redo it by hand.
