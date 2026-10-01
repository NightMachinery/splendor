# Art sources

`originals/` holds the full-quality source images. They are not served. Every
file the client serves under `public/images/icons/`, `public/images/bg/` and
`public/images/title-portrait.*` is derived by `build-assets.py`, from
`originals/` or, for the board backgrounds, from the legacy served file
`public/images/bluebackground.jpg`, which is the original (2500x1668).

Regenerate the derived files after changing a source:

```bash
python3 client/art/build-assets.py              # every target
python3 client/art/build-assets.py turn-icons   # only some: icons, turn-icons, title, boards
python3 client/art/build-assets.py --check      # exit 1 if an output is out of date
```

This needs Pillow and `avifenc` (libavif).

The script is idempotent. It encodes each output in memory and writes it only
when the bytes differ from the file on disk, then prints `unchanged`,
`updated` or `created` for every output. A second run therefore changes
nothing and leaves git clean, and `--check` can run in CI.

## Outputs

- `icons/icon-32.png`, `icon-48.png`, `icon-192.png`, `icon-512.png`: the app
  icon disc with transparent corners (purpose "any").
- `icons/maskable-192.png`, `maskable-512.png`: the disc inside the central
  80% safe zone on navy `#0b2a45`.
- `icons/apple-touch-icon.png`: 180x180, opaque navy.
- `icons/icon-turn-32.png` and `icon-turn-48.png`: the 32 and 48px icons with
  a gold `#e8b84a` dot (12px across at 32px, 18px at 48px) in a navy
  `#0b1422` ring (2px and 3px), flush with the top-right corner. The board
  swaps them in as the favicon while it is your turn; BaseHead names each one
  in the `data-sp-turn-href` of its favicon link.
- `title-portrait.avif` and `.jpg`: the portrait title art, 1024x1792.
- `bg/board-1280.avif` (1280x854, about 26KB), `bg/board-1920.avif`
  (1920x1281, about 94KB) and `bg/board-1280.jpg` (quality 78, about 95KB):
  the board backdrop. The 1280 AVIF uses `--qcolor 55` like the title art.
  The 1920 one uses 52 (higher means better), which still keeps the paper
  grain, where 50 starts to smear it in patches and 55 would cost about 140KB.

## Formats

- Photos and illustrations are served as AVIF, with a JPEG fallback for
  browsers that lack AVIF support (older iOS Safari). In CSS the plain JPEG
  `background-image` comes first and an `image-set()` with `type()` after it,
  so a browser that cannot parse the second declaration keeps the first. The
  `.sp-board-backdrop` primitive in `src/styles/sp/primitives.css` does this.
- Icons stay PNG, because favicon, web-manifest and apple-touch icon support for
  other formats is uneven.
- Maskable icons keep the artwork inside the central 80% safe zone on a solid
  navy background. The apple-touch icon is opaque because iOS renders
  transparent pixels black.

## Provenance

Both originals were generated in 2026-10 with Codex's image generation tool.

- `app-icon-1024.png`: a redraw of the old 200 px `SplendorFavicon.png` at
  1024 px. The prompt asked for a thick polished gold ring around a deep
  teal-blue textured disc with a bevelled gold serif capital S, kept inside the
  central 80% so it works as a maskable icon.
- `title-portrait-1024x1792.png`: an original portrait background for phones in
  the mood of `titleImage.jpg`, without copying it. The prompt asked for a
  domed cathedral skyline and a tall ship in a misty night harbour, with one
  glowing gem in the lower third, and calm, dark top and bottom areas so text
  and buttons stay legible.

`bluebackground.jpg` predates this pipeline; it is the board background the
client has always used.
