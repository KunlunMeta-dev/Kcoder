#!/bin/sh
# Synthetic Cookie values only. Never use this fixture for user credentials.
set -eu
: "${KCODER_TEST_REAL_CHROMIUM:?An explicit installed Chromium is required}"
exec "$KCODER_TEST_REAL_CHROMIUM" --password-store=basic "$@"
