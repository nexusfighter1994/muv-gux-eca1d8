# Home Callback Compatibility, 2026-10-20

Fixes six additional callback recognition regressions against native 2026.10.19.7:
two 24fps normalizations, one library trim with native source preparation, and
three Motion render-only callbacks. Previous supported callbacks remain accepted.
No quality, codec, timing, RAM gate, worker capacity or recovery policy change.

The prior SigLIP correction is included. The new build gate checks 15 reviewed
native call sites across SigLIP, normalization, library trim, Motion, camera,
scene detection and media overlays/mirroring. Each must occur exactly once in
the patched native bundle and pass its installed classifier. Unknown callbacks
and mock Motion remain guarded; validation is not made independently eligible.

Verification: 80 focused tests locally, with production Node22, and in image76.
Three isolated V8 live-edit tests preserve function identities and a Motion
queue/lease. Image76 passes 40 required hooks, syntax and native version checks.

Applied hot without restart on 2026-10-20 at 15:18:54, 15:19:07 and 15:19:22 UTC.
Source persisted locally, on the server and in the running module directory.
The running container and Compose remain image74 plus hot source.
Prepared image: local/vidforge-custom:20261020-76-home-callbacks
Image ID: sha256:2662caa550189b625ec43d85fc4a25f55c9971960149f4ee9382affb9b6b89a3
No recreate or GitHub push performed. An explicitly authorized future recreate
must use this qualified image or a newer verified build, not image74.

Real progress observed: Home normalization active2; Home admissions +116 over
three minutes. Between 15:19:28 and 15:23:05 UTC worker counters increased by
CPU200, NVENC95 and Motion2. These are different lifetime counters, not video
counts or a measured speedup. Independent Motion had no new completion yet:
old motion-native waiters remain untouched and legacy Home work consumes the
available route capacity. Do not claim the entire Motion backlog is fixed.

Private server proofs: /opt/aufsetzen/vf-update-20261020/
Backup: backup-callbacks76; qualified76.json; callbacks76-apply-*.jsonl;
callbacks76-inspect-*.jsonl; tests76-node22.txt; verify76.json;
image76-tests.txt; callback-events76.json.
Promotion and hot apply have already run. Never blindly rerun them.
