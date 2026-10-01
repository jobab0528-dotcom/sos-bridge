// SOS Bridge — common UI state contract (Phase 1 / Step 1).
//
// Pure module: no DOM, window, document, storage or network access, and no
// imports. Not yet wired into the app; future feature modules will return
// results built with createUiResult() so every screen handles the same states.

export const UI_STATE = Object.freeze({
  LOADING: "LOADING",
  SUCCESS: "SUCCESS",
  EMPTY: "EMPTY",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  OFFLINE: "OFFLINE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  TIMEOUT: "TIMEOUT",
  STALE: "STALE",
  UNVERIFIED: "UNVERIFIED",
  FALLBACK_USED: "FALLBACK_USED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  INVALID_INPUT: "INVALID_INPUT"
});

export const UI_STATES = Object.freeze(Object.values(UI_STATE));

// Default retry policy per state (Phase 1 Architecture Design, §16).
// A caller may override it per result with an explicit boolean.
export const DEFAULT_RETRYABLE = Object.freeze({
  [UI_STATE.LOADING]: false,
  [UI_STATE.SUCCESS]: false,
  [UI_STATE.EMPTY]: true,
  [UI_STATE.PARTIAL]: true,
  [UI_STATE.FAILED]: true,
  [UI_STATE.OFFLINE]: true,
  [UI_STATE.PERMISSION_DENIED]: true,
  [UI_STATE.TIMEOUT]: true,
  [UI_STATE.STALE]: true,
  [UI_STATE.UNVERIFIED]: false,
  [UI_STATE.FALLBACK_USED]: true,
  [UI_STATE.NOT_CONFIGURED]: false,
  [UI_STATE.INVALID_INPUT]: false
});

export function isUiState(value){
  return typeof value === "string" && UI_STATES.includes(value);
}

function normalizeReasons(reasons){
  if(!Array.isArray(reasons)) return [];
  return reasons
    .filter((reason) => typeof reason === "string")
    .map((reason) => reason.trim())
    .filter(Boolean);
}

// Builds an immutable { state, data?, reasons, retryable } result.
// An unknown state throws instead of being coerced into another state, so a
// typo or untrusted value can never silently become SUCCESS.
export function createUiResult(state, options = {}){
  if(!isUiState(state)){
    throw new TypeError(`Unknown UI state: ${String(state)}`);
  }
  const settings = options && typeof options === "object" ? options : {};
  const result = {
    state,
    reasons: Object.freeze(normalizeReasons(settings.reasons)),
    retryable: typeof settings.retryable === "boolean" ? settings.retryable : DEFAULT_RETRYABLE[state]
  };
  if(settings.data !== undefined) result.data = settings.data;
  return Object.freeze(result);
}

export function isUiResult(value){
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isUiState(value.state) &&
    Array.isArray(value.reasons) &&
    typeof value.retryable === "boolean"
  );
}
