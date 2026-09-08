# Private runtime asset pack

This directory contains extracted Game Dev Story artwork and audio, copyright Kairosoft,
plus locally derived runtime files. It is tracked in the private Herdr Story repository so a
clone can run the full office without repeating asset extraction.

These files are not covered by the repository's ISC source-code license. Their inclusion does
not grant permission to redistribute them publicly. Keep the repository private unless the
necessary rights have been obtained or the pack and its history have been removed/replaced.

`npm run build:public` and `npm run release:source` exclude this directory. The original raw
extraction inputs remain local under ignored `assets/raw`; do not commit those dumps.

See `docs/assets.md` and `THIRD_PARTY_NOTICES.md` at the repository root for details.
