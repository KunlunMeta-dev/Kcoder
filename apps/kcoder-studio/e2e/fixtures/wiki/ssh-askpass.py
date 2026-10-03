#!/usr/bin/env python3
"""Return an explicitly supplied test SSH credential only to OpenSSH's private pipe."""
import os,sys
if 'password' not in ' '.join(sys.argv[1:]).lower():
    raise SystemExit(1)
sys.stdout.write(os.environ['KCODER_E2E_WINDOWS_PASSWORD'])
