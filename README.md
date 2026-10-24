# VidForge Custom Mods

Current source release: **2026-10-24**, matching the server overlay in image 78
on native VidForge **2026.10.22.12**. Start with [the current release and install
guide](RELEASE-20261024.md), not the older dated guides.

This repository contains the mod source, installers, tests and optional Home
worker integration helpers. It is not a Docker image download and does not
include production data, credentials, licenses or a preconfigured Home tunnel.
Use your own licensed upstream image and your own provider/worker configuration.

Highlights include independent Home rendering and Motion dispatch, SigLIP/Home
callback compatibility, counted server recovery, chunk-poll cleanup, final
assembly fixes, thumbnail subject identity and the `/custom` controls.

The Dockerfile pins the reviewed stock base. Build-time checks fail on unknown
upstream changes; do not bypass them or build on an older custom image.
Five earlier custom patches are now supplied natively and remain retired.

See [the update gate](update-tools/README.md) for backup, verification and
rollback boundaries. No build command by itself authorizes a production restart.
