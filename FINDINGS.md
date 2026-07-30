# FINDINGS

What building this MVP taught us, written for whoever scopes or bids on the
AI-Assisted Error Decoder RFP. Everything below comes from producing and
diagnosing **real** failures (testnet failures we constructed deliberately,
plus wild mainnet captures) during the build — not from reading docs.

## 1. What was harder than expected

### Producing on-chain failures at all

Simulation gates submission: the CLI and SDKs refuse to send a transaction
whose simulation fails, so apply-phase failures — the thing users actually ask
about — can't be produced naively. Three techniques worked:

- **arg-swap**: simulate a benign variant, then submit with swapped arguments
  and the benign variant's `sorobanData`;
- **resource-patch**: shrink declared instructions / resource fee below what
  execution needs;
- **drain-between**: simulate while funded, change the state with a second
  transaction, submit the stale one.

The arg-swap technique produced an unplanned discovery: for any function with
`require_auth`, swapping arguments after assembly fails **in auth, not in the
target logic**, because recorded authorization commits to the exact invocation
(`Error(Auth, InvalidAction)`, "Unauthorized function call for address"). This
is itself a top real-world failure mode (sign one thing, submit another), and
any corpus-building effort will hit it constantly. Corollary: on-chain
contract-layer failures for auth-guarded functions can only be produced by
changing *state*, never *arguments*.

### `ENTRY_ARCHIVED` is nearly extinct in the wild — and unproducible on demand

- In a 100,000-transaction window of recent mainnet history (21,288 failed),
  there were **zero** `INVOKE_HOST_FUNCTION_ENTRY_ARCHIVED` results and zero
  `INSUFFICIENT_REFUNDABLE_FEE`.
- On testnet, the minimum persistent TTL is **120,960 ledgers (~7 days)** —
  nothing archives within a working session. Mainnet: 2,073,600 (~120 days).
- Hunting for already-archived entries also failed: across ~250 contracts
  sampled from three eras of testnet and mainnet history, every instance we
  could still find was live (active contracts get their TTLs extended; the
  dead ones we sampled were dead in ways that don't produce restore preambles).

Consequence: our `entry_archived` and `sim.entry_archived_restore_required`
rules ship with engine-level tests but **without a real recorded fixture**.
This directly validates the spec's open question to SDF: the taxonomy/corpus
milestone is not deliverable for rare-but-critical codes without **Hubble**
(or an archive node), and the RFP should say so explicitly. A bidder claiming
they'll "collect archived-entry failures from RPC" has not tried it.

### Error identity lives in unstable message strings

The precise host error type/code pairs and event message strings differ from
what documentation implies, and several rules only became correct after
inspecting real diagnostic events:

| Assumed | Actual (protocol 27) |
|---|---|
| expired auth ⇒ `Auth.InvalidAction` | `Auth.InvalidInput`, message "signature has expired" (+ ledger numbers in args) |
| unknown function ⇒ `Context.MissingValue` | `WasmVm.MissingValue`, "trying to invoke non-existent contract function" |
| bare invoke without sorobanData ⇒ `txSOROBAN_INVALID` | `txMALFORMED` |
| on-chain budget blowout ⇒ `TRAPPED` | `INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED` **plus** a `Budget.ExceededLimit` diagnostic |
| refundable-fee failure ⇒ one signal | op code `INSUFFICIENT_REFUNDABLE_FEE` **plus** a misleading `Budget.ExceededLimit` event (layer-priority logic required) |

Rules that match on message substrings are the sharpest discriminators we have
(there is often nothing else), but they are protocol-version-fragile. The rule
table needs a fixture per message-matching rule and re-verification at every
protocol upgrade — this is the concrete form of the spec's "rule tables rot"
warning, and it is why the table carries `protocol:` ranges.

### Post-hoc state drift

State checks run at *diagnosis* time, not *failure* time. A trustline that was
missing when the transfer failed may exist by the time someone runs the tool;
a drained balance may have been topped up. Evidence entries therefore carry
the ledger they were observed at, and refutations are worded as "at diagnosis
time". Fully solving this requires historical state access (Hubble again, or
`getLedgerEntries` against an archive node) — a genuine T2 work item, not an
afternoon patch.

## 2. Rules that could not be made deterministic

- **Argument-type mismatch vs. contract panic.** Passing a wrong-typed
  argument does not produce a distinct host error: argument conversion happens
  *inside* the contract's wasm (SDK-generated code), so it surfaces as the
  same `WasmVm.InvalidAction` trap as any `panic!`/`unwrap`. One rule covers
  both, with an explanation that names both possibilities. Distinguishing them
  deterministically would require comparing the invocation against the
  contract's spec types — feasible (the spec is already fetched for error
  resolution) and a good T2 line item.
- **Expired temporary entry vs. never-written storage.** Both end as a `None`
  unwrap panic inside the contract. Only the contract author knows which.
- **Why the budget was exceeded.** The headroom check proves whether raising
  declared resources *can* fix it (declared < network cap), but not *why*
  execution got more expensive (state growth vs. stale simulation vs. logic
  change). We report the actionable half and stay silent on the causal story.
- **Shared error codes.** SAC `BalanceError` (#10) covers both
  sender-insufficient-balance and receiver-trustline-limit; only live
  trustline lookups on both sides separate them. When one lookup is
  unavailable (e.g. the issuer is a party — issuers have no trustline), the
  undiscriminated hypothesis is capped at 0.5 rather than dropped. The
  `required:` check flag exists because of exactly this case.

## 3. Where confidence scoring felt arbitrary

The *mechanism* is principled: refuted ⇒ eliminated; unconfirmed ⇒ capped at
0.5; confirmed ⇒ table value. The table values themselves (0.85 vs 0.9 vs
0.95) are hand-set priors dressed in decimals. With a real labeled corpus the
right move is to *calibrate* them — set each rule's confidence to its measured
precision on held-out data, recomputed per release. The RFP's eval harness
makes this nearly free; bidders should commit to calibrated (not asserted)
confidences, and reviewers should ask how confidences were derived.

## 4. What a real corpus needs (sizing T1 honestly)

- **Access:** mainnet RPC retains ~7 days of `getTransactions`; Horizon has
  full history but cannot filter by result code, so finding rare failures
  means scanning everything. Our 100k-transaction scan took ~10 minutes and
  covered ~2 hours of chain time. Scaling that to a 300-failure corpus with
  ≥15 distinct root causes — including codes that occur zero times in a day —
  is a **Hubble/BigQuery job**, full stop.
- **Label independence:** our 24 labeled fixtures are labeled *by
  construction* (we caused each failure), which is stronger than post-hoc
  labeling but only covers causes we knew to construct. The spec's requirement
  that labels be produced independently of the rule-table author is the
  expensive part of T2 and the reason the accuracy numbers below should not
  impress anyone.
- **Taxonomy-lite, from the 100k scan:** 21.3% of recent mainnet transactions
  failed. The failure mass is overwhelmingly classic: ~73% path-payment
  failures (`pathPaymentStrictSendUnderDestmin` alone is 47%) — slippage, not
  Soroban. Soroban failures: 1,049 (~5% of failures), of which 1,042 were
  `TRAPPED`/fee-bumped-TRAPPED, 7 `RESOURCE_LIMIT_EXCEEDED`. Every wild
  `TRAPPED` we sampled was a **footprint miss** ("access outside declared
  footprint") and every `RESOURCE_LIMIT_EXCEEDED` was declared-below-cap —
  i.e. the dominant real-world Soroban failure mode is **stale simulation:
  state changed between simulate and submit**. "Re-simulate immediately before
  submitting" is the single highest-value fix message on mainnet today.
  Also: **~69% of wild Soroban failures arrive fee-bump-wrapped**, so inner-tx
  unwrapping is not an edge case, it is the common path.
- **Diagnostic events are not guaranteed:** they exist only if the RPC
  provider runs core with diagnostics enabled. The tool degrades to op-layer
  identity and says so; a corpus pipeline must record which provider produced
  each capture.

## 5. What turned out clean (and what that implies)

- **Contract error → name resolution is small.** Wasm section walk + XDR spec
  decode + code lookup, with all degradation paths, is ~300 lines and needed
  no iteration after the first test. This supports the spec's open question:
  it could live upstream in `stellar-cli` / `mcp-stellar-xdr` as core
  plumbing, shrinking this RFP to the knowledge layer (taxonomy + rules +
  eval). We'd recommend asking Leigh before publication, as the spec suggests.
- **The transport seam pays for itself.** All RPC behind a two-method
  interface made record/replay fixtures trivial, which is what makes the eval
  harness honest (byte-identical replays, 0.4 ms p50 resolution latency
  excluding RPC).
- **Simulation inputs need the request envelope.** A `simulateTransaction`
  response alone identifies the host/contract layers but carries no
  invocation, so no state check can run. Accepting the *request* XDR alongside
  (`--request-xdr`) unlocked confirmed diagnoses for simulation failures. Any
  surface built on this design should require or strongly encourage it.

## 6. Current numbers (for calibration, not bragging)

- 45 rules; 34 recorded-replay fixtures (24 labeled, 18 distinct root causes,
  10 wild mainnet); 105 tests, all offline.
- Eval: top-1 100%, top-3 100%, zero confident-wrong in the high-risk subset,
  p50 0.4 ms / p95 1.2 ms (offline replay, RPC excluded).
- These are **against a corpus the rule author controls** — the honest reading
  is "the harness works and the floors are enforceable", not "the tool is 100%
  accurate". Independent labeling (T2) is where real numbers come from.

## 7. Advice to bidders, compressed

1. Budget most of your time for the corpus, not the resolver. The resolver is
   a week; the corpus is the project.
2. Get Hubble access confirmed in writing before you commit to the taxonomy
   milestone (rare codes do not exist in RPC retention windows).
3. Treat message-string matches as versioned data with a fixture each, and
   expect to re-verify all of them at every protocol upgrade.
4. Unwrap fee bumps everywhere; most wild Soroban failures are fee-bumped.
5. Run every check at diagnosis time **and record the observation ledger**;
   design the envelope so historical-state backends can slot in later.
6. Don't promise to distinguish what the chain doesn't distinguish
   (arg-type-vs-panic, temp-expired-vs-never-written) — say `unresolved` or
   present both, and make that a feature of your eval design.
