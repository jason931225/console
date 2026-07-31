// H-1 gate: an operation's requestBody must match the deny_unknown_fields struct its handler binds.
// STUB — the RED-test phase owns the contract; the implementation phase replaces this body.

/**
 * @param {{ repoRoot: string, openApiPath?: string }} _options
 * @returns {{
 *   resolved: number,
 *   skipped: number,
 *   findings: { operation: string, message: string }[],
 *   unresolvedAnchors: string[],
 * }}
 */
export function evaluateRequestBodyContract(_options) {
  throw new Error("unimplemented: evaluateRequestBodyContract");
}
