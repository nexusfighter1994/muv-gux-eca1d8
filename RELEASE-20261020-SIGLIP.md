# SigLIP Home Admission Fix, 2026-10-20

The native update renamed three embedding callbacks. The closed Home allowlist
did not recognize them, so independent Home admission stayed empty even though
the legacy, server-slot-bound GPU transport continued working.

This fix adds the three exact reviewed callbacks. OCR stays native. Model,
scoring, cancellation, deadlines, counted native recovery, RAM admission,
worker capacities and transfer limits are unchanged.

The Docker build now verifies those callbacks against the actual patched native
bundle with `update-tools/verify-siglip-callbacks.mjs`. Future native changes must
be reviewed; do not disable the gate.

Verification: 26 focused tests on the exact image, 40/40 hook checks, syntax and
native-version verification. Live hot activation preserved existing leases.
38 real Home sender successes and zero sender fallbacks observed by14:59UTC.
The pre-existing mixed ranking/OCR backlog is not claimed cleared.

Prepared image: `local/vidforge-custom:20261020-75-siglip-dispatch`.
Immutable ID: `sha256:c138c2b8d10008606aaeb0307b96463884d71e4dae8d8960743273c7454cd60a`.
Production remains74 with the hot correction, no recreate. Use75 or a newer
qualified image for the next authorized recreate; image74 lacks this fix.
