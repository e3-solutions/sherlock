# Native Windows verification excerpt

Source: https://github.com/e3-solutions/sherlock/actions/runs/34699863776/job/103569594176

Tested implementation commit: b91e22b3499137b61c70a02971880ba1215f97fb

Only synthetic local input was used. This excerpt records observed test and provider output; the captured final-ci run separately checks the actual workflow and step conclusions.

```text
2026-09-12T14:38:37.3378855Z Ran 14 tests in 3.953s
2026-09-12T14:38:38.5612359Z Ran 3 tests in 0.536s
2026-09-12T14:38:42.7509217Z Ran 8 tests in 1.323s
2026-09-12T14:39:10.2169710Z Trusted 7 Sherlock hooks through Codex.
2026-09-12T14:39:12.3680222Z   Codex: installed
2026-09-12T14:39:12.3680625Z   Claude Code: installed
2026-09-12T14:39:13.6824706Z Trusted 7 Sherlock hooks through Codex.
2026-09-12T14:39:15.7996093Z   Codex: installed
2026-09-12T14:39:15.7996335Z   Claude Code: installed
2026-09-12T14:39:17.2613099Z codex: exact installed native hook captured immutable UTF-8 bytes
2026-09-12T14:39:17.2613797Z claude_code: exact installed native hook captured immutable UTF-8 bytes
```
