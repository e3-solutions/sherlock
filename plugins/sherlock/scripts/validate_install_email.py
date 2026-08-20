#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Sherlock installation email.")
    parser.add_argument("--email", required=True)
    parser.add_argument("--collector-home", required=True, type=Path)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[3]
    package_root = repo_root / "packages" / "telemetry-collector" / "src"
    sys.path.insert(0, str(package_root))
    from sherlock_collector.config import (
        ConfigurationError,
        validate_install_email_for_home,
    )

    try:
        validate_install_email_for_home(args.email, args.collector_home)
    except ConfigurationError as error:
        raise SystemExit(f"invalid collector identity: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
