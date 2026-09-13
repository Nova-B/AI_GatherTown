# Asset provenance

All pixel art used by Agent Town is copied verbatim from the upstream Pixel Agents checkout (`webview-ui/public/assets`, commit `3537e140c2094761beae748592aeb92ece8edfdd`), which is MIT licensed (Copyright (c) 2026 Pablo De Lucca, see root `LICENSE`). The upstream README credits the six character sheets as based on "Metro City" by JIK-A-4 (<https://jik-a-4.itch.io/metrocity-free-topdown-character-pack>). Furniture, floor, wall and carpet tiles carry no separate attribution in upstream beyond the repository license.

`npm run assets` (also run by `predev`/`prebuild`) regenerates `town/public/assets/` from the upstream folder and writes `ATTRIBUTION.txt` next to the copy. The copy is git-ignored; upstream files are never modified.

## Slicing (verified against upstream `core/src/assets/pngDecoder.ts` and `webview-ui/src/office/sprites/spriteData.ts`)

| Asset | Dimensions | Slicing used by Agent Town |
|---|---|---|
| `characters/char_0..5.png` | 112×96 | 3 rows (down, up, right) × 7 frames of 16×32. Frames 0–2 walk (played 0,1,2,1), 3–4 typing, 5–6 reading. Left = right flipped |
| `walls/wall_0.png` | 64×128 | 4×4 grid of 16×32 pieces; index = bitmask N=1,E=2,S=4,W=8 of wall neighbours; bottom-anchored to the tile; grayscale, tinted |
| `floors/floor_0..8.png` | 16×16 | grayscale patterns, tinted per room |
| `carpets/carpet_0..2.png` | 64×64 | 16 marching-squares pieces; copied but **not used** yet |
| `furniture/<ID>/*.png` + `manifest.json` | various | drawn bottom-anchored to their tile footprint (e.g. `DESK_FRONT` 48×32 = 3×2 tiles, `PC_FRONT_ON_*` 16×32 = 1×2, `WOODEN_CHAIR_BACK` 16×32, `DOUBLE_BOOKSHELF` 32×32 wall decor) |

Furniture used by the fixed layout: DESK, PC, WOODEN_CHAIR, BOOKSHELF, DOUBLE_BOOKSHELF, WHITEBOARD, LARGE_PAINTING, CLOCK, PLANT, PLANT_2, LARGE_PLANT, CACTUS, SOFA, SMALL_TABLE, COFFEE, BIN. The copy script also carries the remaining furniture folders so a future layout can use them.

The favicon (`public/favicon.svg`) is an original 16×16 drawing made for Agent Town. No Gather Town graphics or logos are used.
