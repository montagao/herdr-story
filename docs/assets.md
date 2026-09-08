# Runtime artwork

This private repository includes the runtime pack in `public/assets/gds`: character sheets,
furniture, room textures, HUD graphics, cutscenes, decorations, and audio. A normal clone can
run the full office with `npm ci` and `npm run dev:mock`; asset extraction is not required.
The pack is approximately 3.8 MB, so it uses ordinary Git rather than Git LFS.

The repository also includes attributed CC BY 4.0 props, original code-drawn office elements,
and synthesized music. See `public/assets/open/ATTRIBUTION.md` and `THIRD_PARTY_NOTICES.md`.

## Private assets and public exports

Game Dev Story artwork/audio is copyright Kairosoft and is not covered by the ISC code license.
Tracking it in a private repository does not grant public redistribution rights. Keep this
repository private unless the necessary rights are obtained or the pack and historical copies
are removed/replaced. Office screenshots also depict this artwork.

`npm run build` includes the runtime pack. `npm run build:public` excludes it, copying only the
open/studio assets and fictional demo. `npm run release:source` likewise excludes the runtime
pack from its archive, even though it is tracked here. `npm run check:publication` checks that
public-source selection, not the complete private repository or its history.

Without the pack, the app opens the roster/chat fallback. It supports reading and sending to
existing agents, queues, stop controls, and model controls. Room, hiring, studio, and billing
windows require the office bootstrap. `?roster=1` selects this view explicitly.

## Regenerating the runtime pack

The 126 MB raw extraction sources remain ignored under `assets/raw`. For local regeneration,
`npm run assets` expects sheets under `assets/raw/game-dev-story-graphics/graphics` and
ImageMagick's `convert` command. It checks those prerequisites before replacing the output.
Do not add the raw dumps to Git. Review changes to the generated runtime pack before committing.

A fully redistributable office needs an independently licensed replacement pack. The frame
contract is documented by `src/sprites.ts`, `src/seats.ts`, `src/themes.ts`, and the extraction
scripts. Contributions toward an original pack are welcome; record every asset's provenance.
