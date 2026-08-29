#!/usr/bin/env bash
# One Maestro step at a time: tap "<text regex>" or tap @x%,y%.
U=${UDID:-419EBBF5-5DDA-4E02-9715-EB1F20BEAB87}
f=$(mktemp -t hearth).yaml
if [[ "$1" == @* ]]; then
  printf 'appId: com.binary.rewind.hearth\n---\n- tapOn:\n    point: "%s"\n- waitForAnimationToEnd:\n    timeout: 5000\n' "${1#@}" > "$f"
else
  printf 'appId: com.binary.rewind.hearth\n---\n- tapOn: "%s"\n- waitForAnimationToEnd:\n    timeout: 5000\n' "$1" > "$f"
fi
~/.maestro/bin/maestro --device "$U" test "$f" 2>&1 | grep -E "FAILED|not found"
rm -f "$f"
