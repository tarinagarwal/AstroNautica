# AzaadAwaaz relay: strfry + the Node write-policy plugin (spec §7, §11).
#
# The upstream dockurr/strfry image is Alpine 3.18 (musl) and has no Node, so we
# copy the musl Node binary from the official node:22-alpine image. Node 22 needs
# a newer libstdc++ than Alpine 3.18 ships, so Node's own libstdc++/libgcc go in
# a private directory used only by the `node` wrapper; strfry keeps the system
# libraries it was built against.
FROM node:22-alpine AS node
RUN mkdir -p /opt/node/bin /opt/node/lib \
 && cp /usr/local/bin/node /opt/node/bin/node \
 && cp -L /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /opt/node/lib/

FROM dockurr/strfry:1.1.3
COPY --from=node /opt/node /opt/node
RUN printf '#!/bin/sh\nLD_LIBRARY_PATH=/opt/node/lib exec /opt/node/bin/node "$@"\n' > /usr/local/bin/node \
 && chmod 0755 /usr/local/bin/node \
 && node --version

COPY policy.js /app/azaad-policy.js
COPY scrub-ips.js /app/scrub-ips.js
COPY package.json /app/package.json
COPY strfry.conf /etc/strfry.conf
COPY entrypoint.sh /app/azaad-entrypoint.sh
RUN chmod 0755 /app/azaad-policy.js /app/scrub-ips.js /app/azaad-entrypoint.sh \
 && rm -f /app/write-policy.py

# Policy defaults (spec §7); override per deployment.
ENV POW_DIFFICULTY=16 \
    RATE_COMMENTS_PER_MINUTE=10 \
    RATE_REACTIONS_PER_MINUTE=60 \
    MAX_COMMENT_CHARS=2000

EXPOSE 7777
WORKDIR /app
CMD ["/app/azaad-entrypoint.sh"]
