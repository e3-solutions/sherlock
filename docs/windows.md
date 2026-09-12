# Native Windows

Sherlock uses native Python on Windows. Install Git, Python 3.11 or later, and
Codex or Claude Code before running the installer. Python must be callable as
`py`, `python`, or `python3`; `PYTHON_BIN` can select an explicit interpreter path.
Use a local NTFS user-profile directory for collector state. Network shares and
FAT/exFAT volumes are outside the tested durability and permission contract.

From a Sherlock checkout, Windows PowerShell 5.1 and PowerShell 7 can run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\sherlock.ps1 install -Name "<full name>" -Github "<GitHub username>" -Email "<work email>"
if ($LASTEXITCODE -ne 0) { throw 'Sherlock installation failed' }
```

This process-level execution-policy override does not change machine policy.
For one provider, substitute `install.ps1` or `install-claude.ps1`, omit `install`,
and use the same identity arguments. Re-run the command to update installation.
Start a new provider session after installing so it loads the updated hooks.

## Paths and configuration

Defaults are `%USERPROFILE%\.sherlock\marketplace`, `%USERPROFILE%\.codex`, and
`%USERPROFILE%\.claude`. `SHERLOCK_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`
override these locations. Quote paths with spaces. `CODEX_BIN` and `CLAUDE_BIN`
select explicit CLIs. Standard npm launchers are resolved to their Node script
without sending identity values through a command shell.

The installer preflights identity and available providers, copies the runtime
and a durable local marketplace, and verifies plugin installation. It retains
the installation identifier and queued telemetry on reinstall. Windows uses
native access-control lists for private collector state; POSIX permission bits
continue to protect macOS/Linux state. Source transcripts are read without
modification. Database schemas, raw object formats, and product views are
unchanged.

## Provider interfaces

Codex uses the documented `commandWindows` hook override and installed plugin
root. Its app-server API discovers and verifies trust for only Sherlock hooks.
Claude Code uses its documented native hook interface. Both launch the shared
Python collector, which uses operating-system locks and detached background
draining. No WSL runtime is involved.

Interface sources checked on 2026-09-12:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks, exec form and shell form](https://code.claude.com/docs/en/hooks#exec-form-and-shell-form)

A provider version that cannot install or verify the required hooks must be
updated; a CLI existing on PATH is not sufficient evidence of compatibility.

## Verification and limits

The `Collector platforms` workflow exercises native Windows subprocess locks,
recovery, hook commands, installation, and reinstallation, with separate Unix
regression jobs. Its Windows installer step runs Windows PowerShell 5.1.
Fixture CLIs exercise installer contracts without an account. Provider CLI
smoke tests exercise real plugin registration and trust without issuing model
requests. Neither proves an authenticated desktop session, a particular VPN,
network delivery to production, or dashboard ingestion.

Collector verification reports local state only. A successful install is not
proof that the remote endpoint received or projected telemetry. Keep queued
state when diagnosing connectivity so later drains can retry.

## Rollback

Disable the Sherlock plugin in the affected provider, then install a prior
compatible release if needed. Preserve each provider's `sherlock/telemetry`
directory and `collector.json`; deleting them discards pending uploads and
installation identity. Rollback requires no database migration or raw-data
rewrite.
