# Artwork and the clean-checkout experience

A clean checkout includes a few attributed CC BY 4.0 props, original code-drawn office elements,
and a synthesized music loop. It does **not** include the Game Dev Story sheets used by the full
office, character portraits, HUD trim, cutscenes, and sampled sound effects.

When the core art is missing, the app opens a live roster/chat view and explains why the office
is unavailable. This mode supports reading and sending to existing agents, queues, stop controls,
and model controls. It does not present room, hiring, studio, or billing controls that depend on
the office bootstrap. `?roster=1` selects it explicitly, including with `?demo=1`.

For an existing local asset installation, `npm run assets` expects the source sheets under
`assets/raw/game-dev-story-graphics/graphics` and ImageMagick's `convert` command. It extracts to
ignored `public/assets/gds`. The repository does not supply or download those sheets. Do not
submit them to GitHub. Extraction checks its prerequisites before replacing the existing output.

A complete redistributable office needs an independently licensed replacement pack. The frame
contract is documented by `src/sprites.ts`, `src/seats.ts`, `src/themes.ts`, and the extraction
scripts. Contributions toward an original pack are welcome; record provenance for every asset.
Do not trace or recolor proprietary sheets and describe the result as original.

`npm run build` includes your local public directory for personal use. `npm run build:public`
copies only the committed open/studio assets and fictional demo, excluding local proprietary
art and the sprite lab. Do not publish a personal build directory by accident.
