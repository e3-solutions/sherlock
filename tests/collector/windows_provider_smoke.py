"""Run installed hook definitions after real native provider registration in CI.

This exercises provider-selected command syntax, not an authenticated model turn.
Only synthetic local transcripts are created; the endpoint must be loopback.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import time
import uuid
from urllib.parse import urlparse


def installed_hook(provider_home: Path, name: str):
    candidates = []
    for path in (provider_home / 'plugins' / 'cache').rglob('hooks/hooks.json'):
        root = path.parent.parent
        for metadata in (root / '.codex-plugin/plugin.json', root / '.claude-plugin/plugin.json'):
            if metadata.is_file() and json.loads(metadata.read_text(encoding='utf-8')).get('name') == name:
                candidates.append(path)
                break
    if not candidates:
        raise AssertionError(f'No installed {name} hooks in provider cache')
    path = max(candidates, key=lambda item: item.stat().st_mtime_ns)
    return path.parent.parent, json.loads(path.read_text(encoding='utf-8'))['hooks']['Stop'][0]['hooks'][0]


def verify(provider: str, home: Path, plugin_name: str) -> None:
    config = json.loads((home / 'sherlock/collector.json').read_text(encoding='utf-8'))
    if urlparse(config['endpoint']).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise AssertionError('Smoke test requires a loopback endpoint')
    session_id = str(uuid.uuid4())
    source = (home / 'sessions' / f'rollout-{session_id}.jsonl' if provider == 'codex'
              else home / 'projects' / 'windows smoke' / f'{session_id}.jsonl')
    source.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps({'type':'event_msg' if provider == 'codex' else 'user',
                           'sessionId': session_id, 'text':'synthetic Windows snowman ☃',
                           'timestamp':'2026-09-12T00:00:00Z'}, ensure_ascii=False) + '\n').encode('utf-8')
    source.write_bytes(payload)
    before = source.stat().st_mtime_ns
    plugin_root, handler = installed_hook(home, plugin_name)
    environment = os.environ.copy()
    for name in ('PYTHONPATH', 'SHERLOCK_COLLECTOR_SOURCE', 'SHERLOCK_CONFIG_PATH'):
        environment.pop(name, None)
    environment.update(PLUGIN_ROOT=str(plugin_root), CLAUDE_PLUGIN_ROOT=str(plugin_root))
    hook_input = json.dumps({'session_id':session_id, 'transcript_path':str(source),
                             'hook_event_name':'Stop'}).encode('utf-8')
    if provider == 'codex':
        # Matches Codex's default Windows runner: COMSPEC /C + raw quoted command.
        command = f'"{os.environ.get("COMSPEC", "cmd.exe")}" /C "{handler["commandWindows"]}"'
    else:
        command = [handler['command'], *[
            argument.replace('${CLAUDE_PLUGIN_ROOT}', str(plugin_root))
            for argument in handler['args']]]
    started = time.monotonic()
    result = subprocess.run(command, input=hook_input, capture_output=True,
                            env=environment, timeout=15)
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert time.monotonic() - started < 10, 'Hook did not return promptly'
    if provider == 'codex':
        assert json.loads(result.stdout) == {'continue':True}, result.stdout
    deadline = time.monotonic() + 20
    found = False
    queue_root = home / 'sherlock/telemetry/queue'
    while time.monotonic() < deadline:
        for state in ('pending', 'processing'):
            for artifact in (queue_root / state).glob('*.json'):
                try:
                    value = json.loads(artifact.read_text(encoding='utf-8'))
                    stored = base64.b64decode(value['stored_payload_base64'])
                    if gzip.decompress(stored) == payload:
                        found = True
                        break
                except (FileNotFoundError, PermissionError):
                    continue
            if found:
                break
        if found:
            break
        time.sleep(0.1)
    assert found, f'{provider}: installed hook did not durably spool exact source bytes'
    assert source.read_bytes() == payload
    assert source.stat().st_mtime_ns == before
    print(f'{provider}: exact installed native hook captured immutable UTF-8 bytes')


if __name__ == '__main__':
    assert os.name == 'nt', 'Native Windows smoke only'
    verify('codex', Path(os.environ['CODEX_HOME']), 'sherlock')
    verify('claude_code', Path(os.environ['CLAUDE_CONFIG_DIR']), 'sherlock-claude-code')
