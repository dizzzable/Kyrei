export interface ComposerFocusRecoveryState {
  hadComposerFocus: boolean;
  disabled: boolean;
  documentHasFocus: boolean;
  shellIsInert: boolean;
}

/**
 * Reclaim the text input only after the desktop window itself stole focus.
 * Modal panels use `inert`, so their focus trap always remains authoritative.
 */
export function shouldRestoreComposerFocus(state: ComposerFocusRecoveryState): boolean {
  return state.hadComposerFocus
    && !state.disabled
    && state.documentHasFocus
    && !state.shellIsInert;
}
