# Sherlock

Sherlock collects Codex session activity for team analytics, including prompts,
tool use, primary agents, and subagents. Telemetry is uploaded to the team's
Sherlock backend and processed asynchronously.

## Download and install

You need Git, Python 3, and the Codex CLI.

```sh
git clone https://github.com/e3-solutions/sherlock.git
cd sherlock
./install.sh \
  --name "<full name>" \
  --github-id "<GitHub username>" \
  --email "<work email>"
```

Use the same work email on every machine that should be linked to you. If an
agent is installing Sherlock for someone else, it must ask for these three
values instead of inferring them.

After installation, start a new Codex task so the hooks load.

## Verify

```sh
codex plugin list --marketplace sherlock
```

For implementation and operations details, see:

- [Data schema](docs/data-schema.md)
- [Telemetry processing](docs/telemetry-processing.md)
- [CodeActivity dashboard](apps/dashboard/README.md)
