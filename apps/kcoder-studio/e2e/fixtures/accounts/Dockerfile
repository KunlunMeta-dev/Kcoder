FROM ubuntu:24.04
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 openssh-server passwd util-linux libdbus-1-3 ca-certificates && rm -rf /var/lib/apt/lists/*
