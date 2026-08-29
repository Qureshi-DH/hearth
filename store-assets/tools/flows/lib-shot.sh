#!/usr/bin/env bash
# Screenshot the simulator into raw/<name>.png after a short settle.
U=${UDID:-419EBBF5-5DDA-4E02-9715-EB1F20BEAB87}
sleep "${2:-2}"
xcrun simctl io "$U" screenshot "${RAW:?set RAW}/$1.png" >/dev/null 2>&1 && echo "shot $1"
