# Publishing

This checkout starts with a new initial commit built from the reviewed source, including a
fictional demo. The original Git metadata and a source snapshot were backed up privately outside
this repository. The runtime art pack was subsequently added for private clones; secrets, raw
extraction dumps, and local runtime state remain ignored.

The private GitHub repository now uses the fresh history, but it includes Kairosoft runtime
assets and may retain historical content from the previous history, including real studio
captures. Do not simply flip it to public or merge old private branches into a public release.
For public publication, initialize new history from a reviewed source archive that excludes
the runtime pack, and use a new empty repository. Reusing the existing repository needs a
separate review of historical content and remote refs. A force-push of main alone is not proof
that old commits, pull-request refs, or cached content have been removed.

Use `npm run check`, `npm run test:release`, and `npm run release:source`. The source archive is
built from current source files, explicitly excluding `public/assets/gds`, `.git`, and local captures. Keep the private
backup out of public repositories and build artifacts. No GitHub visibility or remote history
was changed by the local reset itself; main was later pushed to the existing private repository.

The publication check excludes the private runtime art pack, then detects known credential shapes, forbidden file paths, and changes to the
fictional demo. It is not proof that every secret or identifying detail has been found. Review
source, tests, docs, and assets, and use GitHub secret scanning when available. Rotate any actual
credential discovered in material that has already been shared.

Before a public release:

- Use a new clean source archive/history that excludes the runtime pack; do not publish this
  private history, which now includes the assets.
- Keep Kairosoft artwork/audio and private screenshots out of source and build artifacts. The
  complete graphical office still needs an independently licensed replacement pack.
- Enable private vulnerability reporting, branch protection requiring CI, and dependency alerts
  in GitHub settings. CI configuration alone cannot enable these repository settings.
- Activate GitHub Sponsors (see sponsorship.md). No payment account was created automatically.
- Confirm a fresh `npm ci`, `npm run check`, and `npm run test:release` work on the extracted tree.

The application is experimental and has no independent security audit or hosted-service auth.
Tag a release only after reviewing its exact contents and known limitations.
