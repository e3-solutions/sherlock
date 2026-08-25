export const FRAME_VERSION = "frame-evidence-v3";

export const FRAME_CODEX_NORMALIZER_VERSION = "sherlock.codex-rollout.v2";
export const FRAME_CLAUDE_NORMALIZER_VERSION =
  "sherlock.claude-code-transcript.v1";
export const FRAME_NORMALIZER_VERSIONS = Object.freeze([
  FRAME_CODEX_NORMALIZER_VERSION,
  FRAME_CLAUDE_NORMALIZER_VERSION,
]);

export const FRAME_WINDOW_HOURS = 26;

export const FRAME_PAIRING_NEIGHBORHOOD_SECONDS = 6;
