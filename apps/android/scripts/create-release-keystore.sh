#!/bin/sh
# Creates the release signing keystore if it does not exist yet. The keystore lives OUTSIDE the repository
# (default ~/.azaadawaaz/release.keystore, override with AZAAD_KEYSTORE). Losing it means users can't update
# (Android only installs updates signed with the same key): back it up encrypted, in two places, like the onion keys.
#
#   AZAAD_KEYSTORE_PASSWORD=… [AZAAD_KEYSTORE=/path] [AZAAD_KEY_ALIAS=azaadawaaz] sh scripts/create-release-keystore.sh
set -eu
KEYSTORE="${AZAAD_KEYSTORE:-$HOME/.azaadawaaz/release.keystore}"
ALIAS="${AZAAD_KEY_ALIAS:-azaadawaaz}"
: "${AZAAD_KEYSTORE_PASSWORD:?set AZAAD_KEYSTORE_PASSWORD (at least 12 characters)}"
if [ "${#AZAAD_KEYSTORE_PASSWORD}" -lt 12 ]; then echo "AZAAD_KEYSTORE_PASSWORD must have at least 12 characters" >&2; exit 1; fi

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$(cd "$(dirname "$KEYSTORE")" 2>/dev/null && pwd || dirname "$KEYSTORE")/" in
  "$REPO"/*) echo "refusing to create the keystore inside the repository ($REPO)" >&2; exit 1 ;;
esac

if [ -f "$KEYSTORE" ]; then
  echo "keystore exists: $KEYSTORE"
else
  mkdir -p "$(dirname "$KEYSTORE")"
  chmod 700 "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -storetype PKCS12 \
    -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=AzaadAwaaz" \
    -storepass "$AZAAD_KEYSTORE_PASSWORD" -keypass "$AZAAD_KEYSTORE_PASSWORD"
  chmod 600 "$KEYSTORE"
  echo "created $KEYSTORE"
fi
echo "signing certificate SHA-256 (goes into the release list as signingCertSha256):"
keytool -list -v -keystore "$KEYSTORE" -storepass "$AZAAD_KEYSTORE_PASSWORD" -alias "$ALIAS" | sed -n 's/^.*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f'
echo "export AZAAD_KEYSTORE=$KEYSTORE AZAAD_KEY_ALIAS=$ALIAS (and AZAAD_KEYSTORE_PASSWORD) before building a release."
