# Sherlock Codex plugin

The plugin captures immutable Codex telemetry and includes the explicitly
invoked `sherlock-analysis` skill. The skill asks the local Codex agent to
exhaust one snapshot-bound evidence traversal, inspect local code with native
tools, submit one complete candidate batch (including empty), and present a
fixed-high-water candidate traversal for conversation.

Installation does not configure MCP or bundle a bearer. Configure the remote
HTTP endpoint manually with `bearer_token_env_var` and a secret supplied to the
Codex process, following the [current MCP contract](../../docs/bonaparte-mcp.md).
Sherlock does not verify submitter/reviewer identity or persist review decisions.
Stored free text is bounded untrusted potentially sensitive content and is not
semantically sanitized.
