#!/usr/bin/env python3
"""Compare real CLI command contracts using only owned offline fixtures."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--administrative", action="store_true",
                        help="Compare offline configuration and authentication commands too.")
    args = parser.parse_args()
    binaries = [args.before.resolve(strict=True), args.after.resolve(strict=True)]
    results = []
    with tempfile.TemporaryDirectory(prefix="kcoder-build-contract-") as temporary:
        root = Path(temporary)
        workspace = root / "workspace"
        workspace.mkdir()
        config = root / "config.toml"
        config.write_text('model="fixture-model"\nmodel_provider="fixture"\n'
                          '[model_providers.fixture]\nname="Fixture"\n'
                          'base_url="https://example.invalid/v1"\nenv_key="KCODER_UNUSED_TEST_KEY"\n')
        commands = [["--version"], ["--help"], ["migrate", "--help"],
                    ["migrate", "configure", "--help"], ["migrate", "history", "--help"],
                    ["migrate", "budget", "--help"], ["migrate", "transfer", "--help"],
                    ["migrate", "scan", "--source", "codex", "--config", str(config)],
                    ["migrate", "budget", "--target-profile", str(root / "profile"),
                     "increase", "--scope", "batch", "--job-id", "original"]]
        if args.administrative:
            commands.extend([
                ["config", "--help"], ["auth", "--help"], ["auth", "status", "--json"],
                ["config", "path"], ["config", "templates"],
            ])
        for index, command in enumerate(commands):
            outputs = []
            for side, binary in zip(["before", "after"], binaries):
                private = root / f"{index}-{side}"
                private.mkdir()
                env = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "SystemRoot", "SYSTEMROOT", "WINDIR",
                                  "COMSPEC", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"}}
                env.update(HOME=str(private), USERPROFILE=str(private), KCODER_HOME=str(private),
                           KCODER_CONFIG_DIR=str(private / "profile"), NO_COLOR="1")
                # Clap derives usage from argv[0], independently of executable identity.
                result = subprocess.run(["kcoder", *command], executable=str(binary), cwd=workspace, env=env,
                                        capture_output=True, text=True, timeout=30)
                outputs.append(dict(exit_code=result.returncode,
                                    stdout=result.stdout.replace(str(private), "<private>"),
                                    stderr=result.stderr.replace(str(private), "<private>")))
            equal = outputs[0] == outputs[1]
            results.append(dict(command=command, equal=equal, before=outputs[0], after=outputs[1]))
            print(f"{'PASS' if equal else 'FAIL'} {' '.join(command[:4])}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(results, indent=2) + "\n")
    return 0 if all(item["equal"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
