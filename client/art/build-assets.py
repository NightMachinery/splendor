#!/usr/bin/env python3
"""Derive the served images in client/public/images from client/art/originals.

Requires Pillow and avifenc (libavif). Re-run after changing an original:

    python3 client/art/build-assets.py
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ART = Path(__file__).resolve().parent
ORIGINALS = ART / "originals"
PUBLIC = ART.parent / "public" / "images"
ICONS = PUBLIC / "icons"

ICON_BG = (11, 42, 69, 255)  # deep navy behind maskable / apple-touch icons


def square_disc(path):
    """Crop the transparent margin and pad to an exact square so resizing never distorts."""
    src = Image.open(path).convert("RGBA")
    left, top, right, bottom = src.getbbox()
    side = max(right - left, bottom - top)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(
        src.crop((left, top, right, bottom)),
        ((side - (right - left)) // 2, (side - (bottom - top)) // 2),
    )
    return square


def build_icons():
    ICONS.mkdir(parents=True, exist_ok=True)
    disc = square_disc(ORIGINALS / "app-icon-1024.png")

    def fit(size):
        return disc.resize((size, size), Image.LANCZOS)

    # "any" purpose icons keep the transparent corners.
    for size in (32, 48, 192, 512):
        fit(size).save(ICONS / f"icon-{size}.png", optimize=True)

    # Maskable icons: the disc stays inside the central 80% safe zone.
    # The apple-touch icon is opaque because iOS paints transparency black.
    for size, fraction, name in (
        (512, 0.80, "maskable-512.png"),
        (192, 0.80, "maskable-192.png"),
        (180, 0.92, "apple-touch-icon.png"),
    ):
        canvas = Image.new("RGBA", (size, size), ICON_BG)
        inner = round(size * fraction)
        canvas.alpha_composite(fit(inner), ((size - inner) // 2, (size - inner) // 2))
        canvas.convert("RGB").save(ICONS / name, optimize=True)


def build_title_portrait():
    original = ORIGINALS / "title-portrait-1024x1792.png"
    image = Image.open(original).convert("RGB")
    # JPEG fallback for browsers without AVIF support (older iOS Safari).
    image.save(PUBLIC / "title-portrait.jpg", quality=80, optimize=True, progressive=True)
    avifenc = shutil.which("avifenc")
    if not avifenc:
        raise SystemExit("avifenc not found; install libavif (brew install libavif)")
    with tempfile.TemporaryDirectory() as tmp:
        flat = Path(tmp) / "title-portrait.png"
        image.save(flat)
        subprocess.run(
            [avifenc, "--qcolor", "55", "--speed", "4", "--yuv", "420",
             str(flat), str(PUBLIC / "title-portrait.avif")],
            check=True, stdout=subprocess.DEVNULL,
        )


if __name__ == "__main__":
    build_icons()
    build_title_portrait()
    for path in sorted([*ICONS.glob("*"), *PUBLIC.glob("title-portrait.*")]):
        print(f"{path.relative_to(ART.parent)}  {path.stat().st_size // 1024} KiB")
