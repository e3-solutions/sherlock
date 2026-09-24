#!/usr/bin/env python3
"""Install shared Cursor IDE/CLI user hooks without replacing unrelated hooks."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', required=True)
    parser.add_argument('--github-id', required=True)
    parser.add_argument('--email', required=True)
    parser.add_argument('--cursor-home', type=Path, default=Path.home() / '.cursor')
    parser.add_argument('--endpoint', default=os.environ.get('SHERLOCK_INGEST_URL',
        'https://psmuyotyyojrkojycyzz.supabase.co/functions/v1/sherlock-rollout-ingest'))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo / 'packages/telemetry-collector/src'))
    from sherlock_collector.cursor_hook import EVENTS
    from sherlock_collector.spool import secure_lock
    import fcntl
    home = args.cursor_home.expanduser().resolve()
    home.mkdir(parents=True, exist_ok=True)
    with secure_lock(home / '.sherlock-install.lock') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        path = home / 'hooks.json'
        if path.is_symlink():
            raise SystemExit('Refusing to replace a symlink hooks.json')
        original = path.read_bytes() if path.exists() else None
        settings = json.loads(original) if original else {'version': 1, 'hooks': {}}
        if not isinstance(settings, dict) or settings.get('version') != 1:
            raise SystemExit('Unsupported Cursor hooks configuration')
        hooks = settings.setdefault('hooks', {})
        if not isinstance(hooks, dict) or any(not isinstance(v, list) for v in hooks.values()):
            raise SystemExit('Cursor hooks must be arrays')
        installer = repo / 'plugins/sherlock/scripts/install.py'
        subprocess.run([sys.executable, str(installer), '--collector-home', str(home),
            '--endpoint', args.endpoint, '--name', args.name,
            '--github-id', args.github_id, '--email', args.email], check=True)
        launcher = home / 'sherlock' / 'cursor-hook.py'
        launcher.write_text('import sys\nfrom pathlib import Path\n'
            'sys.path.insert(0, str(Path(__file__).resolve().parent / "runtime"))\n'
            'from sherlock_collector.cursor_hook import main\n'
            'raise SystemExit(main())\n')
        launcher.chmod(0o700)
        for event in sorted(EVENTS):
            command = shlex.join([sys.executable, str(launcher), '--home', str(home), event])
            # Exact generated command equality makes reinstall idempotent.
            entries = hooks.setdefault(event, [])
            if not any(isinstance(v, dict) and v.get('command') == command for v in entries):
                entries.append({'command': command, 'timeout': 10, 'failClosed': False})
        spec = importlib.util.spec_from_file_location('sherlock_installer', installer)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if original is not None:
            backup = home / 'sherlock' / 'cursor-hooks.before-install.json'
            if not backup.exists():
                backup.write_bytes(original)
                backup.chmod(0o600)
        module.atomic_json(path, settings)
    print('Installed Cursor IDE/CLI hooks. No history was uploaded; future hooks collect observations.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
