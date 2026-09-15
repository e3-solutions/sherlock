"""The optional cue must not depend on a writable temporary filesystem."""
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


def test_preview_dispatch_survives_temporary_file_failure():
    path = Path(__file__).resolve().parents[2] / "plugins/sherlock-claude-code/scripts/run_hook.py"
    spec = importlib.util.spec_from_file_location("replay_failure_fixture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with patch.dict(os.environ, {"E3_COLLECTIVE_FEEDBACK_HOOK_ENABLED": "1",
                                 "E3_COLLECTIVE_HOOK_ENABLED": "0"}):
        with patch.object(sys, "argv", [str(path), "SessionStart"]), patch.object(
            sys, "stdin", io.StringIO('{"source":"startup","fixture":"original"}')
        ), patch.object(tempfile, "TemporaryFile", side_effect=OSError("synthetic disk full")), patch.object(
            module, "dispatch", return_value=0
        ) as dispatch:
            assert module.main() == 0
            dispatch.assert_called_once()
