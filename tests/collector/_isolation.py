"""Keep collector tests independent of the developer's owner-local policy.

Sherlock honours ~/.sherlock/session-exclusions.json (or $SHERLOCK_HOME). Tests
that exercise capture and upload must not inherit a real policy from the
machine running them, so point SHERLOCK_HOME at an empty private directory
unless a test sets it explicitly.
"""

import atexit
import os
import shutil
import tempfile

if "SHERLOCK_HOME" not in os.environ:
    _home = tempfile.mkdtemp(prefix="sherlock-test-home-")
    atexit.register(shutil.rmtree, _home, True)
    os.environ["SHERLOCK_HOME"] = _home
