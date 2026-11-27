#!/usr/bin/env python3
"""Inject a protected model credential only into the requested test command."""

from __future__ import annotations

import os
import re
import sys


def validate_name(name: str) -> None:
    reserved = {
        "PATH", "HOME", "USERPROFILE", "SHELL", "ENV", "IFS", "CDPATH",
        "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "KCODER_CONFIG_DIR", "KCODER_HOME",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENSSL_CONF", "OPENSSL_MODULES",
    }
    upper = name.upper()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or upper in reserved or upper.startswith(
        ("LD_", "DYLD_", "BASH_", "GIT_", "NODE_", "NPM_", "PYTHON", "RUST", "CARGO_", "MALLOC_", "GLIBC_")
    ):
        raise ValueError("Protected model credential environment name is unsafe")


def main(arguments: list[str]) -> int:
    try:
        name = os.environ.get("KCODER_E2E_MODEL_CREDENTIAL_ENV", "")
        validate_name(name)
        if arguments == ["--validate-name"]:
            return 0
        credential = os.environ.get("KCODER_E2E_MODEL_CREDENTIAL_VALUE")
        if not credential:
            raise ValueError("Protected model credential is missing")
        if arguments == ["--check-credential"]:
            return 0
        if not arguments:
            raise ValueError("A protected test command is required")
        environment = dict(os.environ)
        environment[name] = credential
        os.execvpe(arguments[0], arguments, environment)
    except (ValueError, OSError) as error:
        # Neither the supplied name nor credential belongs in diagnostics.
        print("Unable to start protected model test: " + (str(error) if isinstance(error, ValueError)
              else "command could not be executed"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
