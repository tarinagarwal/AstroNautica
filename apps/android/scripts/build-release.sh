#!/bin/sh
# Builds the signed release APK inside the React Native Android build image (Android SDK 37, build-tools 37.0.0,
# NDK 28.2, JDK 17). Needs AZAAD_KEYSTORE, AZAAD_KEYSTORE_PASSWORD and AZAAD_KEY_ALIAS (see create-release-keystore.sh),
# network access to Google's Maven repository and Maven Central, and the workspace libraries built
# (`pnpm -r --filter "./packages/*" build`). Output: android/app/build/outputs/apk/release/app-release.apk
#
#   DEFAULTS_CONFIG=/path/prod-config.json DEFAULTS_LIST_EVENTS=/path/lists.json sh scripts/build-release.sh
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
IMAGE="${AZAAD_BUILD_IMAGE:-reactnativecommunity/react-native-android:latest}"
: "${AZAAD_KEYSTORE:?run scripts/create-release-keystore.sh and export AZAAD_KEYSTORE}"
: "${AZAAD_KEYSTORE_PASSWORD:?export AZAAD_KEYSTORE_PASSWORD}"
ALIAS="${AZAAD_KEY_ALIAS:-azaadawaaz}"

node "$HERE/scripts/gen-defaults.mjs"
node "$HERE/scripts/copy-fonts.mjs"

docker volume create azaad-gradle-cache >/dev/null
docker run --rm \
  -v "$REPO:/repo" \
  -v azaad-gradle-cache:/root/.gradle \
  -v "$(dirname "$AZAAD_KEYSTORE"):/keys:ro" \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e AZAAD_KEYSTORE="/keys/$(basename "$AZAAD_KEYSTORE")" \
  -e AZAAD_KEYSTORE_PASSWORD -e AZAAD_KEY_PASSWORD -e AZAAD_KEY_ALIAS="$ALIAS" \
  -e AZAAD_VERSION_CODE -e AZAAD_VERSION_NAME \
  -w /repo/apps/android/android \
  "$IMAGE" ./gradlew --no-daemon assembleRelease

APK="$HERE/android/app/build/outputs/apk/release/app-release.apk"
echo "built $APK"
node "$HERE/scripts/release-entry.mjs" "$APK"
