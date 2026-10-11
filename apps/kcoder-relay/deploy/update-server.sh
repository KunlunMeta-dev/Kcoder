#!/usr/bin/env bash
set -Eeuo pipefail

cat >&2 <<'MESSAGE'
This legacy source-only updater is disabled for Gateway registry deployments.
It would replace server code without transferring the matching private registry.
Use the complete deployment entry point instead:

  node apps/kcoder-relay/src/deploy.mjs

That flow validates the active single-domain config, stages credentials with mode 0600,
transfers the registry over SSH when configured, and installs it for the relay service user.
MESSAGE
exit 64
