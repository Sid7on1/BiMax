/** Native observation failures are not TCC diagnoses merely because they mention Accessibility. */
export type ReadFailureKind = 'permission_denied' | 'app_unready' | 'read_timeout' | 'read_failed';
export type ReadFailure = { kind: ReadFailureKind; accessibilityGranted?: boolean };
export function diagnoseReadFailure(text: string, accessibilityGranted?: boolean): ReadFailure {
  const axRelated = /accessibility|assistive|\bAX(?: tree|Window|Error| is)|\bax_(?:tree_empty|app_launching|window_unresolved)/i.test(text);
  // Hosts without the native probe may only trust an explicit permission refusal, never an AX timeout/degradation.
  const explicitDenial = /(?:process|AX) is not trusted|(?:accessibility|assistive) (?:permission|access) (?:is )?(?:not granted|required|denied|missing|disabled)|(?:k)?AXErrorAPIDisabled/i.test(text);
  const kind: ReadFailureKind = axRelated && (accessibilityGranted === false || accessibilityGranted === undefined && explicitDenial)
    ? 'permission_denied'
    : /\bax_(?:tree_empty|app_launching|window_unresolved)/i.test(text) ? 'app_unready'
    : /timeout|timed? out|stopped answering|did not return/i.test(text) ? 'read_timeout' : 'read_failed';
  return { kind, ...(accessibilityGranted !== undefined ? { accessibilityGranted } : {}) };
}
