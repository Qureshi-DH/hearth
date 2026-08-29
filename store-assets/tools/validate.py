#!/usr/bin/env python3
"""Checks every store image against what the stores accept, and fails loudly.

  python3 store-assets/tools/validate.py

Exact pixel size for its folder, RGB with no alpha (the icon for Play is the
one image that may carry alpha), under the size cap, and within each store's
count limits. Then the listing text against each field's character limit,
and the listing URLs for anything still a placeholder.
"""
import glob
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MB = 1024 * 1024

# folder glob, (w, h), max bytes, (min count, max count), alpha allowed
RULES = [
    ("app-store/screenshots/iphone-6.9-1320x2868/*.png", (1320, 2868), 10 * MB, (1, 10), False),
    ("play/screenshots/phone-1080x1920/*.png", (1080, 1920), 8 * MB, (2, 8), False),
    ("play/graphics/feature-graphic_1024x500.png", (1024, 500), 15 * MB, (1, 1), False),
    ("play/graphics/icon_512x512.png", (512, 512), 1 * MB, (1, 1), True),
    ("app-store/graphics/icon_1024x1024.png", (1024, 1024), 10 * MB, (1, 1), False),
]

failed = False
for pattern, size, cap, (low, high), alpha_ok in RULES:
    files = sorted(glob.glob(os.path.join(ROOT, pattern)))
    if not low <= len(files) <= high:
        print(f"FAIL {pattern}: {len(files)} files, expected {low} to {high}")
        failed = True
    for path in files:
        image = Image.open(path)
        problems = []
        if image.size != size:
            problems.append(f"size {image.size[0]}x{image.size[1]}, expected {size[0]}x{size[1]}")
        if not alpha_ok and ("A" in image.getbands() or image.mode not in ("RGB", "L")):
            problems.append(f"mode {image.mode}, expected RGB with no alpha")
        if os.path.getsize(path) > cap:
            problems.append(f"{os.path.getsize(path) / MB:.1f} MB, over {cap / MB:.0f} MB")
        name = os.path.relpath(path, ROOT)
        if problems:
            failed = True
            print(f"FAIL {name}: {'; '.join(problems)}")
        else:
            print(f"PASS {name}  {image.size[0]}x{image.size[1]} {image.mode} {os.path.getsize(path) / MB:.2f} MB")

# Listing text, against each field's character limit. A field that ships
# empty is as much a rejection as one that runs long.
TEXT = [
    ("app-store/metadata/en-US/name.txt", 30),
    ("app-store/metadata/en-US/subtitle.txt", 30),
    ("app-store/metadata/en-US/promotional_text.txt", 170),
    ("app-store/metadata/en-US/description.txt", 4000),
    ("app-store/metadata/en-US/keywords.txt", 100),
    ("play/metadata/en-US/title.txt", 30),
    ("play/metadata/en-US/short_description.txt", 80),
    ("play/metadata/en-US/full_description.txt", 4000),
    ("play/metadata/en-US/changelogs/default.txt", 500),
]
for rel, limit in TEXT:
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        print(f"FAIL {rel}: missing")
        failed = True
        continue
    text = open(path, encoding="utf-8").read().strip()
    if not 0 < len(text) <= limit:
        print(f"FAIL {rel}: {len(text)} characters, limit {limit}")
        failed = True
    else:
        print(f"PASS {rel}  {len(text)}/{limit}")

for rel in glob.glob(os.path.join(ROOT, "*/metadata/en-US/*_url.txt")):
    url = open(rel, encoding="utf-8").read().strip()
    name = os.path.relpath(rel, ROOT)
    if not url.startswith("https://") or "REPLACE" in url:
        print(f"TODO {name}: {url}")
        failed = True
    else:
        print(f"PASS {name}  {url}")

sys.exit(1 if failed else 0)
