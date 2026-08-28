# Independent integration review

## Initial verdict: NO SHIP

- The first SQLSTATE and wrapped-XX000 predicates could retry permanent tenant or authentication failures forever.
- ECHECKOUTTIMEOUT used the fast connectivity backoff instead of the protective capacity backoff.
- Renaming database_capacity_circuit_* would have broken existing alerts.
- A real worker/postgres.js refused-connection boundary and shutdown path had not been exercised.

## Remediation

- Replaced SQLSTATE class matching with an explicit transient allowlist and narrowed wrapped XX000 matching to low-level econnrefused, econnreset, or etimedout tokens.
- Added negative regressions for 08004, tenant-not-found, wrapped authentication, statement timeout, serialization, and generic XX000.
- Classified ECHECKOUTTIMEOUT as capacity and asserted its 30-second first retry.
- Restored the established database_capacity_circuit_* events and added failure_kind.
- Added a real subprocess boundary that runs main.ts/postgres.js against a refused localhost PostgreSQL port, observes repeated recovery without exit, sends SIGTERM during backoff, and verifies clean pool shutdown.

## Final verdict: SHIP

No remaining P1/P2 findings. Residual uncertainty is bounded: the real boundary produces direct ECONNREFUSED, while the observed Supavisor XX000 wrapper is covered deterministically rather than by deliberately disrupting production.
