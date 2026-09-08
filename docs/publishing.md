# Publishing

This checkout starts with a new initial commit built from the reviewed source, including a
fictional demo. The original Git metadata and a source snapshot were backed up privately outside
this repository. Local ignored artwork, configuration, and runtime files are not in the commit.

The existing private GitHub repository still has the previous history, including real studio
captures. Do not simply flip that repository to public or merge its old branches into this one.
Publish this clean history to a new empty GitHub repository, or separately review replacement
and removal of every old remote ref before reusing the old repository. A force-push of main alone
is not proof that old commits, pull-request refs, or cached content have been removed.

Use `npm run check`, `npm run test:release`, and `npm run release:source`. The source archive is
built from non-ignored current source files, without `.git` or local captures. Keep the private
backup out of public repositories and build artifacts. No GitHub visibility or remote history
was changed by the local reset.

The publication check detects known credential shapes, forbidden file paths, and changes to the
fictional demo. It is not proof that every secret or identifying detail has been found. Review
source, tests, docs, and assets, and use GitHub secret scanning when available. Rotate any actual
credential discovered in material that has already been shared.

Before a public release:

- Publish only this fresh history; do not import refs from the previous private repository.
- Keep Kairosoft artwork/audio and private screenshots out of source and build artifacts. The
  complete graphical office still needs an independently licensed replacement pack.
- Enable private vulnerability reporting, branch protection requiring CI, and dependency alerts
  in GitHub settings. CI configuration alone cannot enable these repository settings.
- Activate GitHub Sponsors (see sponsorship.md). No payment account was created automatically.
- Confirm a fresh `npm ci`, `npm run check`, and `npm run test:release` work on the extracted tree.

The application is experimental and has no independent security audit or hosted-service auth.
Tag a release only after reviewing its exact contents and known limitations.
