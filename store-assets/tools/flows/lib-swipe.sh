#!/usr/bin/env bash
# Swipe from one screen percentage to another: lib-swipe.sh 50%,86% 50%,55%
U=${UDID:-419EBBF5-5DDA-4E02-9715-EB1F20BEAB87}
f=$(mktemp -t hearth).yaml
printf 'appId: com.binary.rewind.hearth\n---\n- swipe:\n    start: "%s"\n    end: "%s"\n    duration: 600\n- waitForAnimationToEnd:\n    timeout: 5000\n' "$1" "$2" > "$f"
~/.maestro/bin/maestro --device "$U" test "$f" 2>&1 | grep -E "FAILED"
rm -f "$f"
