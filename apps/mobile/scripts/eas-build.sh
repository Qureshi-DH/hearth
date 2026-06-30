#!/usr/bin/env bash
# Runs an EAS build. Android release signing comes from the keystore EAS holds
# for this project, and EAS injects it into build.gradle after the config
# plugins run, so nothing set here can change which key signs the build.
# Keep a copy of that keystore outside the repository (eas credentials can
# download it) and see docs/docs/developer/mobile.md before touching it.
set -euo pipefail

exec npx eas-cli@latest build "$@"
