/**
 * The normalized diagnosis envelope: the single frozen contract every other
 * layer depends on. Version bumps to `schema_version` are semver-meaningful:
 * additive optional fields bump the minor, anything else bumps the major.
 */

export const SCHEMA_VERSION = "1.0";

export type Network = "mainnet" | "testnet" | "futurenet" | "local" | "unknown" | string;

export type InputKind = "tx_hash" | "simulation" | "xdr";

/** Where in a transaction's life the failure happened. */
export type FailurePhase =
  /** Rejected by core before inclusion (sendTransaction ERROR / TransactionResult without a ledger). */
  | "submission"
  /** Failed during simulateTransaction. */
  | "simulation"
  /** Included in a ledger and failed during apply. */
  | "apply"
  | "unknown";

export type ErrorLayer = "tx" | "op" | "host" | "contract" | "diagnostic";

export interface EnvelopeInput {
  kind: InputKind;
  /** tx hash, file path, or a short prefix of the pasted XDR. */
  ref: string | null;
}

export interface EnvelopeStatus {
  /** Canonical transaction result code, e.g. "txFAILED". Null when the input is a simulation. */
  tx: string | null;
  /** Canonical operation result code, e.g. "INVOKE_HOST_FUNCTION_TRAPPED". */
  op: string | null;
  phase: FailurePhase;
  /** True when the input turned out not to be a failure at all. */
  successful: boolean;
}

export interface HostErrorInfo {
  /** ScError type, e.g. "Budget", "Auth", "Storage", "WasmVm", "Contract". */
  type: string;
  /** ScError code, e.g. "ExceededLimit", "InvalidAction", "MissingValue", or "#7" for contract codes. */
  code: string;
}

export type ContractErrorSource = "contractspecv0" | "sac_builtin";

export interface ContractErrorInfo {
  contract_id: string | null;
  code: number;
  /** Enum variant name, e.g. "InsufficientBalance". Null when unresolvable. */
  name: string | null;
  /** Doc comment on the enum case, when the spec carries one. */
  doc: string | null;
  /** Name of the error enum type the code resolved through. */
  enum_name: string | null;
  /** How the name was resolved. Null when it could not be resolved. Never guessed. */
  resolved_from: ContractErrorSource | null;
}

export interface EnvelopeError {
  /**
   * Stable namespaced identity of the most specific error layer observed,
   * e.g. "soroban.contract.error", "soroban.host.budget.exceeded_limit",
   * "op.invoke_host_function.entry_archived", "tx.insufficient_fee".
   */
  id: string | null;
  layer: ErrorLayer | null;
  /** Raw form, e.g. "Error(Contract, #7)" or the bare result code. */
  raw: string | null;
  host_error: HostErrorInfo | null;
  contract_error: ContractErrorInfo | null;
}

export interface DiagnosticEventView {
  /** Emitting contract (C... address) when present. */
  contract_id: string | null;
  /** "diagnostic" | "contract" | "system" */
  type: string;
  /** Decoded topics, best-effort human form. */
  topics: unknown[];
  /** Decoded data, best-effort human form. */
  data: unknown;
  /** True when the event was emitted during a call that ultimately failed. */
  in_successful_contract_call: boolean;
}

export type EvidenceOutcome = "confirmed" | "refuted" | "unavailable" | "info";

export interface Evidence {
  /** Check kind that produced this, e.g. "ttl", "trustline", "resource_usage". */
  type: string;
  /** Where the observation came from, e.g. "rpc:getLedgerEntries", "envelope:sorobanData". */
  source: string;
  outcome: EvidenceOutcome;
  /** Ledger key / account / asset the check inspected, when applicable. */
  key?: string;
  observed?: unknown;
  expected?: unknown;
  detail?: string;
}

export interface Fix {
  summary: string;
  commands: string[];
}

export interface Diagnosis {
  cause_id: string;
  /**
   * 0..1. Rules whose confirming checks all passed carry their table
   * confidence. Anything unconfirmed is hard-capped at 0.5.
   */
  confidence: number;
  /** True when at least one state-lookup check confirmed the hypothesis. */
  confirmed: boolean;
  explanation: string;
  evidence: Evidence[];
  fix: Fix | null;
  verify: string[];
  references: string[];
}

export interface UnresolvedNote {
  reason:
    | "no_rule_matched"
    | "rule_checks_unavailable"
    | "layer_missing"
    | "contract_error_unresolved"
    | "input_incomplete"
    | "not_a_failure"
    | "unsupported";
  detail: string;
}

export interface EliminatedHypothesisView {
  cause_id: string;
  /** The refuting evidence: why this hypothesis was ruled out. */
  evidence: Evidence[];
}

export interface Envelope {
  schema_version: typeof SCHEMA_VERSION;
  network: Network;
  protocol_version: number | null;
  input: EnvelopeInput;
  status: EnvelopeStatus;
  error: EnvelopeError;
  diagnostic_events: DiagnosticEventView[];
  diagnoses: Diagnosis[];
  /** Hypotheses that matched but were refuted by state lookups. */
  eliminated: EliminatedHypothesisView[];
  unresolved: UnresolvedNote[];
  references: string[];
  /** Context extracted from the transaction envelope, when available. */
  transaction: TransactionContext | null;
}

/** Facts about the failing transaction that rules and humans both use. */
export interface TransactionContext {
  hash: string | null;
  ledger: number | null;
  created_at: number | null;
  source_account: string | null;
  fee: string | null;
  /** Soroban-specific declared resources, when the tx carries sorobanData. */
  resources: {
    instructions: number;
    disk_read_bytes: number;
    write_bytes: number;
    resource_fee: string;
  } | null;
  footprint: {
    read_only: FootprintKeyView[];
    read_write: FootprintKeyView[];
  } | null;
  /** The invoked contract call, when the failing op is InvokeHostFunction. */
  invocation: {
    contract_id: string | null;
    function_name: string | null;
    args: unknown[];
    host_function_type: string;
  } | null;
  auth: AuthEntryView[];
  operations: { type: string; index: number }[];
  /** Index of the failing operation within the transaction, when known. */
  failed_operation_index: number | null;
}

export interface FootprintKeyView {
  /** e.g. "contract_data", "contract_code", "account", "trustline" */
  type: string;
  /** Human-readable summary of the key. */
  summary: string;
  /** Base64 LedgerKey XDR, for feeding back into RPC lookups. */
  xdr: string;
  contract_id?: string;
  durability?: string;
  /** For contract_data keys: the storage key as base64 ScVal XDR (feeds `--key-xdr` CLI flags). */
  scval_xdr?: string;
}

export interface AuthEntryView {
  credential_type: "source_account" | "address";
  address: string | null;
  nonce: string | null;
  signature_expiration_ledger: number | null;
  /** False when an address-credential entry carries no signature payload. */
  signed: boolean | null;
  root_invocation: string;
}

/* ------------------------------------------------------------------ */
/* Library API                                                         */
/* ------------------------------------------------------------------ */

export type DiagnoseInput =
  | { kind: "tx_hash"; hash: string }
  | {
      kind: "simulation";
      response: unknown;
      /** The simulated TransactionEnvelope (base64 XDR); enables invocation/auth context and state checks. */
      request_xdr?: string;
      ref?: string;
    }
  | { kind: "xdr"; base64: string };

export interface DiagnoseOptions {
  /** Named network or custom; drives default RPC URL selection. */
  network?: Network;
  /** Explicit RPC URL; overrides the network default. */
  rpcUrl?: string;
  /** Injected transport (fixtures replay through this). */
  transport?: JsonRpcTransport;
  /** Path to a rules YAML file; defaults to the bundled table. */
  rulesPath?: string;
  /** Include full evidence trails and all diagnostic events. */
  verbose?: boolean;
  /** Hard cap on state-lookup RPC calls during resolution. */
  maxLookups?: number;
}

export interface JsonRpcTransport {
  call(method: string, params: unknown): Promise<unknown>;
  /** Human-readable origin for evidence `source` fields. */
  readonly label: string;
}
