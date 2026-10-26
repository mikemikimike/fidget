#!/usr/bin/env python3
"""Cut every drawn row of the PetsCodex duck, preserving the authored manifest.

    python3 scripts/import-rubber-duck.py ~/.codex/pets/rubber-duck-debugger

Requires Pillow, as scripts/import-pet.py does. Row numbers below start at one,
matching the source sheet. Loop timing and animation roles live in the manifest.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ROWS = (
    ("idle", 1, 7),
    ("walk", 2, 8),
    ("walk-left", 3, 8),
    ("talk", 4, 4),
    ("jump", 5, 5),
    ("doze", 6, 8),
    ("wave", 7, 6),
    ("thinking", 8, 6),
    ("pondering", 9, 6),
    ("look-right", 10, 8),
    ("look-left", 11, 8),
)
# 105px is 12.5% shorter than the importer's default 120px standing height.
STAND_HEIGHT = 105


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, default=ROOT / "characters/rubber-duck/frames")
    args = parser.parse_args()

    spec = importlib.util.spec_from_file_location("pet_import", ROOT / "scripts/import-pet.py")
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)

    source = args.source.expanduser()
    metadata = json.loads((source / "pet.json").read_text())
    if metadata["id"] != "rubber-duck-debugger":
        parser.error("source must be the rubber-duck-debugger pet")
    sheet = Image.open(source / metadata["spritesheetPath"]).convert("RGBA")
    atlas = importer.detect_atlas(*sheet.size)
    if atlas is None or atlas[1] != 11:
        parser.error("the duck requires the eleven-row atlas")
    _, _, cell_w, cell_h = atlas

    animations = {}
    for name, row, count in ROWS:
        animations[name] = {
            "frames": [
                importer.strip_edge_bleed(sheet.crop(
                    (col * cell_w, (row - 1) * cell_h, (col + 1) * cell_w, row * cell_h)
                ))
                for col in range(count)
            ],
            "fps": 4,
            "loop": "forever",
            "variant_of": None,
        }

    pet = {
        "name": "Rubber Duck",
        "license": None,
        "source": {
            "art": metadata["description"],
            "url": "https://petscodex.com/pets/rubber-duck-debugger",
        },
        "notes": [],
        "animations": animations,
    }
    destination = args.out
    with tempfile.TemporaryDirectory(prefix="fidget-duck-import-") as scratch:
        output = Path(scratch)
        importer.emit(pet, output, validate=False, stand=STAND_HEIGHT)
        for path in (output / "frames").glob("*.png"):
            image = Image.open(path).convert("RGBA")
            alpha = image.getchannel("A").tobytes()
            bottom = max(
                row for row in range(image.height)
                if sum(a >= 128 for a in alpha[row * image.width:(row + 1) * image.width]) >= 3
            )
            grounded = Image.new("RGBA", image.size)
            grounded.paste(image, (0, image.height - 1 - bottom))
            grounded.save(path)

        destination.mkdir(parents=True, exist_ok=True)
        for old in destination.glob("*.png"):
            old.unlink()
        for path in (output / "frames").glob("*.png"):
            shutil.copy2(path, destination / path.name)
    print(f"{sum(count for _, _, count in ROWS)} source frames, all eleven rows, grounded")


if __name__ == "__main__":
    main()
