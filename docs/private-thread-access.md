# Private thread viewer

The private viewer is a separate service and data view for Aqil. Its HTTP origin
requires credentials for every page, asset, and API request except `/healthz`.
The public service excludes Aqil from its source reads, including historical
session and prompt queries. Raw telemetry remains unchanged.

Configure `SHERLOCK_PRIVATE_VIEW=true` and `SHERLOCK_PRIVATE_ACCOUNTS` as a JSON
object with exactly `aqil@e3group.ai` and `caleb@e3group.ai` keys. Each value is
the SHA256 hex digest of that person's independently generated high entropy
password. Missing or invalid configuration returns HTTP 503; unauthenticated
requests return HTTP 401 with a browser Basic authentication challenge. Account
names are case insensitive. Caller-supplied identity headers grant no access.

Generate passwords from at least 32 random bytes and distribute each credential
manually through an approved private channel. Do not place passwords in links,
repository files, logs, or shared chat. SHA256 here relies on random passwords;
it is unsuitable for storing human-selected passwords. This is credential-based
access, not email ownership verification, SSO, or MFA. Anyone holding a person's
credential can use that account. Rotate its password digest to revoke access.

Serve only over HTTPS. Protect the application origin itself so both the custom
hostname and Railway-generated hostname enforce the same gate. Private MCP is
disabled because a shared MCP bearer token does not identify an approved person.
Log successful sensitive reads using only account email, route path, and time;
never log authorization headers, query strings, passwords, or prompt content.

The boundary does not restrict database administrators, immutable raw storage,
or other services with independent database access. Infrastructure access must
be separately limited to approved operators. Installation still records a
declared collector email; collector email ownership is not verified by this gate.
