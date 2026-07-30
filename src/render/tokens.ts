/**
 * Token estimation for output budgeting. We deliberately do not ship a real
 * tokenizer: an approximation biased to overcount keeps the default response
 * honestly under budget for any mainstream model.
 * Empirically JSON runs ~3.3–4 chars/token; we assume 3.3.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}
