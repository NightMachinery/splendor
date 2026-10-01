#!/usr/bin/env python3
"""Derive the served images in client/public/images from their sources.

Requires Pillow and avifenc (libavif). Re-run after changing a source:

    python3 client/art/build-assets.py            # build every target
    python3 client/art/build-assets.py boards     # build only some targets
    python3 client/art/build-assets.py --check    # exit 1 if any output is out of date

Targets: icons, turn-icons, title, boards. The script is idempotent: every
output is encoded in memory and written only when its bytes differ from the
file on disk, so a second run reports "unchanged" for everything and leaves
git clean.
"""
import io
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ART = Path(__file__).resolve().parent
ORIGINALS = ART / "originals"
PUBLIC = ART.parent / "public" / "images"
ICONS = PUBLIC / "icons"
BOARD_BG = PUBLIC / "bg"
# The board background original is the legacy served file itself.
BOARD_BG_ORIGINAL = PUBLIC / "bluebackground.jpg"

ICON_BG = (11, 42, 69, 255)  # deep navy behind maskable / apple-touch icons
TURN_GOLD = (0xE8, 0xB8, 0x4A, 255)  # --sp-gold
TURN_RING = (0x0B, 0x14, 0x22, 255)  # --sp-bg


class Outputs:
    """Writes outputs only when their bytes change, and remembers what happened."""

    def __init__(self, check):
        self.check = check
        self.rows = []

    def write(self, path, data):
        old = path.read_bytes() if path.exists() else None
        if old == data:
            status = "unchanged"
        elif self.check:
            status = "STALE" if old is not None else "MISSING"
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            status = "updated" if old is not None else "created"
        self.rows.append((status, path, len(data)))

    @property
    def out_of_date(self):
        return [row for row in self.rows if row[0] in ("STALE", "MISSING")]


def png_bytes(image):
    buf = io.BytesIO()
    image.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def jpeg_bytes(image, quality):
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def avif_bytes(image, qcolor):
    avifenc = shutil.which("avifenc")
    if not avifenc:
        raise SystemExit("avifenc not found; install libavif (brew install libavif)")
    with tempfile.TemporaryDirectory() as tmp:
        flat = Path(tmp) / "in.png"
        out = Path(tmp) / "out.avif"
        image.save(flat)
        subprocess.run(
            [avifenc, "--qcolor", str(qcolor), "--speed", "4", "--yuv", "420", str(flat), str(out)],
            check=True, stdout=subprocess.DEVNULL,
        )
        return out.read_bytes()


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


def icon_disc():
    disc = square_disc(ORIGINALS / "app-icon-1024.png")
    return lambda size: disc.resize((size, size), Image.LANCZOS)


def build_icons(out):
    fit = icon_disc()
    # "any" purpose icons keep the transparent corners.
    for size in (32, 48, 192, 512):
        out.write(ICONS / f"icon-{size}.png", png_bytes(fit(size)))

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
        out.write(ICONS / name, png_bytes(canvas.convert("RGB")))


def with_turn_badge(icon, dot, ring):
    """The icon plus a gold dot `dot` px across with a `ring` px navy ring, flush top-right."""
    size = icon.size[0]
    scale = 8  # draw large, then box-downsample, for clean anti-aliased edges
    outer = dot + 2 * ring
    layer = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x0 = (size - outer) * scale
    draw.ellipse([x0, 0, x0 + outer * scale - 1, outer * scale - 1], fill=TURN_RING)
    inset = ring * scale
    draw.ellipse([x0 + inset, inset, x0 + inset + dot * scale - 1, inset + dot * scale - 1], fill=TURN_GOLD)
    badged = icon.copy()
    badged.alpha_composite(layer.reduce(scale))
    return badged


def build_turn_icons(out):
    """Favicons shown while it is your turn (WP-HUD swaps them in)."""
    fit = icon_disc()
    for size, dot, ring in ((32, 12, 2), (48, 18, 3)):
        out.write(ICONS / f"icon-turn-{size}.png", png_bytes(with_turn_badge(fit(size), dot, ring)))


def build_title_portrait(out):
    image = Image.open(ORIGINALS / "title-portrait-1024x1792.png").convert("RGB")
    # JPEG fallback for browsers without AVIF support (older iOS Safari).
    out.write(PUBLIC / "title-portrait.jpg", jpeg_bytes(image, 80))
    out.write(PUBLIC / "title-portrait.avif", avif_bytes(image, 55))


def build_board_backgrounds(out):
    """Board backdrop downscales, served through image-set() with the JPEG first as the fallback."""
    src = Image.open(BOARD_BG_ORIGINAL).convert("RGB")
    # --qcolor: higher is better. At 1920, 55 would cost about 140 KiB; 52
    # still keeps the paper grain (50 starts to smear it) at about 94 KiB.
    for width, qcolor in ((1280, 55), (1920, 52)):
        height = round(src.height * width / src.width)
        image = src.resize((width, height), Image.LANCZOS)
        out.write(BOARD_BG / f"board-{width}.avif", avif_bytes(image, qcolor))
        if width == 1280:
            out.write(BOARD_BG / "board-1280.jpg", jpeg_bytes(image, 78))


TARGETS = {
    "icons": build_icons,
    "turn-icons": build_turn_icons,
    "title": build_title_portrait,
    "boards": build_board_backgrounds,
}


def main(argv):
    check = "--check" in argv
    names = [a for a in argv if not a.startswith("--")]
    unknown = [a for a in argv if a.startswith("--") and a != "--check"] + [n for n in names if n not in TARGETS]
    if unknown:
        print(f"unknown argument(s): {' '.join(unknown)}; targets are {', '.join(TARGETS)}", file=sys.stderr)
        return 2
    out = Outputs(check)
    for name in names or TARGETS:
        TARGETS[name](out)
    for status, path, size in out.rows:
        print(f"{status:9}  {path.relative_to(ART.parent)}  {size // 1024} KiB")
    if check and out.out_of_date:
        print(f"{len(out.out_of_date)} output(s) out of date; run python3 client/art/build-assets.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
