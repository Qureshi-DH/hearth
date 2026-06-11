#!/usr/bin/env bash
# Runs an EAS build with the release keystore already in the environment.
#
# The keystore lives outside the repository and gradle reads it through the
# ORG_GRADLE_PROJECT_ prefix, which is what plugins/withAndroidReleaseSigning.ts
# looks for. Signing has to stay on this exact key: Android rejects an update
# signed with a different one, so a build signed by anything else would strand
# everyone who already installed Hearth.
set -euo pipefail

PROPS="${HEARTH_KEYSTORE_PROPERTIES:-$HOME/.hearth/keystores/hearth-release.properties}"

if [ -f "$PROPS" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PROPS"
  set +a
  export ORG_GRADLE_PROJECT_HEARTH_UPLOAD_STORE_FILE="$HEARTH_UPLOAD_STORE_FILE"
  export ORG_GRADLE_PROJECT_HEARTH_UPLOAD_STORE_PASSWORD="$HEARTH_UPLOAD_STORE_PASSWORD"
  export ORG_GRADLE_PROJECT_HEARTH_UPLOAD_KEY_ALIAS="$HEARTH_UPLOAD_KEY_ALIAS"
  export ORG_GRADLE_PROJECT_HEARTH_UPLOAD_KEY_PASSWORD="$HEARTH_UPLOAD_KEY_PASSWORD"
else
  echo "No keystore properties at $PROPS." >&2
  echo "Debug signing will be used, which is fine for trying the app and must" >&2
  echo "not be given to anyone. See docs/docs/developer/mobile.md." >&2
fi

exec npx eas-cli@latest build "$@"
