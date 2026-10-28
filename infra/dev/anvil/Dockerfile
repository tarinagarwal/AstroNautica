# Anvil (Foundry's local EVM node) for the dev network.
#
# The official ghcr.io/foundry-rs/foundry image would do, but GHCR blob
# downloads are not reachable from every network we develop on, so this pulls
# the pinned release tarball from GitHub (verified by SHA-256) onto Debian slim.
FROM debian:bookworm-slim

ARG FOUNDRY_VERSION=v1.3.5
ARG TARGETARCH=amd64
ARG FOUNDRY_SHA256_amd64=9746c51f76c57ee2b099aa67d8b6fb8a93c82175671b654b1b8fd8ddba8e3b42
ARG FOUNDRY_SHA256_arm64=01228ac84a30ec65c49b9f0da38183f4665c196245a3f9156a54bc98c7e94ab0

ADD https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_${TARGETARCH}.tar.gz /tmp/foundry.tar.gz

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) expected="$FOUNDRY_SHA256_amd64" ;; \
      arm64) expected="$FOUNDRY_SHA256_arm64" ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "$expected  /tmp/foundry.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin anvil cast; \
    rm /tmp/foundry.tar.gz; \
    useradd --create-home --uid 1000 foundry; \
    mkdir -p /home/foundry/state; chown foundry:foundry /home/foundry/state; \
    anvil --version

USER foundry
WORKDIR /home/foundry
EXPOSE 8545
ENTRYPOINT ["anvil"]
CMD ["--host", "0.0.0.0", "--port", "8545", "--chain-id", "31337"]
