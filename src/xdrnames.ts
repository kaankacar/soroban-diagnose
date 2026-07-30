/**
 * Canonical naming for XDR result codes and error identities.
 *
 * The JS SDK exposes enum values with camelCase names ("txBadSeq",
 * "invokeHostFunctionTrapped", "sceBudget"). The rest of the ecosystem —
 * docs, Horizon, stellar-core — talks in the XDR spelling
 * ("txBAD_SEQ", "INVOKE_HOST_FUNCTION_TRAPPED"). We normalize to the XDR
 * spelling for display and to lower-snake namespaced ids for matching.
 */

export function camelToSnakeUpper(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

export function camelToSnakeLower(s: string): string {
  return camelToSnakeUpper(s).toLowerCase();
}

/** "txBadSeq" -> "txBAD_SEQ" (Horizon / stellar-core spelling). */
export function txResultCodeName(sdkName: string): string {
  if (!sdkName.startsWith("tx")) return camelToSnakeUpper(sdkName);
  return "tx" + camelToSnakeUpper(sdkName.slice(2));
}

/** "txBadSeq" -> "tx.bad_seq" */
export function txResultCodeId(sdkName: string): string {
  const bare = sdkName.startsWith("tx") ? sdkName.slice(2) : sdkName;
  return "tx." + camelToSnakeLower(bare);
}

/** "opBadAuth" -> "opBAD_AUTH" */
export function opWrapperCodeName(sdkName: string): string {
  if (!sdkName.startsWith("op")) return camelToSnakeUpper(sdkName);
  return "op" + camelToSnakeUpper(sdkName.slice(2));
}

/**
 * Operation-level result code, e.g.
 *   opType "invokeHostFunction", code "invokeHostFunctionTrapped"
 *   -> name "INVOKE_HOST_FUNCTION_TRAPPED", id "op.invoke_host_function.trapped"
 */
export function opResultCode(opType: string, sdkCodeName: string): { name: string; id: string } {
  const name = camelToSnakeUpper(sdkCodeName);
  let suffix = sdkCodeName;
  if (sdkCodeName.toLowerCase().startsWith(opType.toLowerCase())) {
    suffix = sdkCodeName.slice(opType.length);
  }
  const id = `op.${camelToSnakeLower(opType)}.${camelToSnakeLower(suffix)}`;
  return { name, id };
}

/** "sceWasmVm" -> "WasmVm", "scecExceededLimit" -> "ExceededLimit" */
export function scErrorTypeName(sdkName: string): string {
  return sdkName.startsWith("sce") ? sdkName.slice(3) : sdkName;
}
export function scErrorCodeName(sdkName: string): string {
  return sdkName.startsWith("scec") ? sdkName.slice(4) : sdkName;
}

/** ("Budget","ExceededLimit") -> "soroban.host.budget.exceeded_limit" */
export function hostErrorId(type: string, code: string): string {
  return `soroban.host.${camelToSnakeLower(type)}.${camelToSnakeLower(code)}`;
}

/** ("Budget","ExceededLimit") -> "Error(Budget, ExceededLimit)" (Rust debug spelling). */
export function hostErrorRaw(type: string, code: string): string {
  return `Error(${type}, ${code})`;
}

export function contractErrorRaw(code: number): string {
  return `Error(Contract, #${code})`;
}

export const CONTRACT_ERROR_ID = "soroban.contract.error";
