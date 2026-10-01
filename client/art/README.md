# Art sources

`originals/` holds the full-quality source images. They are not served. Every
file the client serves under `public/images/icons/` and
`public/images/title-portrait.*` is derived from them by `build-assets.py`.

Regenerate the derived files after changing an original:

```bash
python3 client/art/build-assets.py
```

This needs Pillow and `avifenc` (libavif).

## Formats

- Photos and illustrations are served as AVIF, with a JPEG fallback for
  browsers that lack AVIF support (older iOS Safari).
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
