export const FRAME_CURSOR_NORMALIZER_VERSION = "sherlock.cursor-hook.v1";
export const FRAME_VERSION = "frame-evidence-v6";
export const FRAME_CORRECTED_CODEX_NORMALIZER_VERSION =
  "sherlock.codex-rollout.v3";

export const FRAME_LEGACY_CODEX_NORMALIZER_VERSION =
  "sherlock.codex-rollout.v1";
export const FRAME_CODEX_NORMALIZER_VERSION = "sherlock.codex-rollout.v2";
export const FRAME_CLAUDE_NORMALIZER_VERSION =
  "sherlock.claude-code-transcript.v1";
export const FRAME_NORMALIZER_VERSIONS = Object.freeze([
  FRAME_CURSOR_NORMALIZER_VERSION,
  FRAME_CORRECTED_CODEX_NORMALIZER_VERSION,
  FRAME_LEGACY_CODEX_NORMALIZER_VERSION,
  FRAME_CODEX_NORMALIZER_VERSION,
  FRAME_CLAUDE_NORMALIZER_VERSION,
]);

export const FRAME_WINDOW_HOURS = 26;
// Certify more than the 24-hour dashboard while allowing rolling worker receipts
// to advance during the handoff without losing the required coverage.
export const FRAME_ACTIVATION_WINDOW_HOURS = 25;

export const FRAME_PAIRING_NEIGHBORHOOD_SECONDS = 6;
