#!/usr/bin/env bash
# Builds the self-hosted "Skofo T3" Android app (ca.skofo.t3) and signs it with the skofo
# release key. Run from anywhere on the T3 cockpit VM:
#
#   apps/mobile/scripts/skofo-android-release.sh [--skip-prebuild]
#
# Needs: Node 26 (~/.local/toolchains/node-v26.12.1-linux-x64), JDK 21, the Android SDK in
# ~/Android/Sdk (Gradle fetches the NDK and build tools it needs), and `bw` for the key password
# ("Skofo T3 Android app (ca.skofo.t3) - release keystore password"). The keystore lives outside
# Git at ~/.config/skofo-t3/ca.skofo.t3-release.jks. Output: apps/mobile/dist/skofo-t3-<version>.apk
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/toolchains/node-v26.12.1-linux-x64/bin:${PATH}"
export ANDROID_HOME="${ANDROID_HOME:-${HOME}/Android/Sdk}"
export ANDROID_SDK_ROOT="${ANDROID_HOME}"
export APP_VARIANT=skofo
export EXPO_NO_GIT_STATUS=1
KEYSTORE="${SKOFO_T3_KEYSTORE:-${HOME}/.config/skofo-t3/ca.skofo.t3-release.jks}"
KEY_ITEM="Skofo T3 Android app (ca.skofo.t3) - release keystore password"
ABIS="${SKOFO_T3_ABIS:-arm64-v8a,x86_64}"

cd "${MOBILE_DIR}"
if [[ "${1:-}" != "--skip-prebuild" ]]; then
  npx expo prebuild --clean --platform android --no-install
fi
# --no-daemon: a leftover multi-GB Gradle daemon starves the T3 agents' memory cgroup on this VM.
(cd android && ./gradlew --no-daemon assembleRelease -PreactNativeArchitectures="${ABIS}" --console=plain)

unsigned="android/app/build/outputs/apk/release/app-release.apk"
version="$(node -p "require('../server/package.json').version")-$(git rev-parse --short HEAD)"
mkdir -p dist
out="dist/skofo-t3-${version}.apk"
apksigner="$(ls -d "${ANDROID_HOME}"/build-tools/*/apksigner | sort -V | tail -1)"
# Re-sign the Gradle output (signed with the template's debug key) with the skofo release key.
bw exec --env KS_PW="password:${KEY_ITEM}" -- \
  "${apksigner}" sign --ks "${KEYSTORE}" --ks-key-alias skofo-t3 \
  --ks-pass env:KS_PW --key-pass env:KS_PW --out "${out}" "${unsigned}"
"${apksigner}" verify --print-certs "${out}" | grep -E "Signer.*certificate (DN|SHA-256)"
sha256sum "${out}"
