# VidForge Custom Layer Update Gate

Current release: see `../RELEASE-20261024.md`. The current base digest is
`sha256:4c26a7fe069c3b3b4b5898d0782890996ec1a0f1eb5e7abe4aa5a973704c58b3`,
native health version `2026.10.22.12`, contract `vf-custom-41-20261023`.
The gate requires 41 checks plus exact Home/SigLIP callback verification.
Reviewed native FX directory protection
replaces the retired marker injection. The older 34-hook release contract
below documents the initial October 15 gate and is historical.

This directory is sidecar tooling only. It does not deploy, edit compose, change
canonical source, contact providers, or mutate the production queue/database.
The parent owns integration into `context/apply.py` and `context/Dockerfile`.
No Brain writes are part of this task.

## Release Contract

- Stock upstream base: `afflicted9436/tayzu31t3@sha256:f1e9c60fdfb3593d747bc3c2aa56bd8700a2c23f3706ba60459c282c6b520c67`.
- Expected native app release: `2026.10.13.7`, from the bundled `/api/health`
  version constant. Upstream `package.json` is the placeholder `1.0.0` and its
  OCI version label is absent; neither is the authoritative native release.
- Parent-reported candidate: `local/vidforge-custom:20261015-27-upstream`.
- Independent hook contract: `vf-custom-34-20261015` in
  `validate-hook-report.py`. Exactly 34 distinct functional hooks are required.
- `node.bundle` is the only known optional report entry. It denotes an
  already-patched bundle on idempotent reapply, is not one of the 34 functional
  hooks, and must also be exactly the string `ok` when present.

Every missing hook, unknown hook, non-`ok` value, duplicate JSON key, malformed
report, missing required file, failed syntax check, or unavailable check fails
closed. There is no `--force`, skip list, auto-learn, or permissive fallback.
Do not remove a requirement just to make a new upstream image pass. Additions,
renames, and upstream-native replacements require a reviewed contract change
and regression evidence for the preserved behavior.

## Parent Integration and Reapply Hardening

The standalone verifier is defense in depth, not a replacement for a fatal
build-time check. Final read-only inspection confirmed the parent has copied the
validator into staging, integrated a checked subprocess immediately before
`done`/`sys.exit(0)`, and pinned the Dockerfile digest plus contract/upstream
labels. The parent reports the rebuilt candidate passes 34/34 hooks. This
sidecar has not independently inspected that actual Docker image.

REAPPLY HARDENING (parent is incorporating): do not retain
`report.update(previous.get('report', {}))`, which can replace a fresh failure
with a prior success. Step 4 preserves fresh-result precedence; steps 2-3 also
make prior-report loading strict. The complete integration contract is recorded
below so future updates cannot omit these protections or the fatal gate.

1. Copy `validate-hook-report.py` into the build context beside `apply.py`.
   Existing `COPY . /opt/vf-custom` then includes it. Include this helper in the
   canonical overlay/source archive as part of the parent's approved integration.
2. Add `import runpy` beside the standard-library imports in `apply.py`, then,
   immediately after the existing `HERE = ...` assignment, load the helper:

```python
HOOK_GATE = runpy.run_path(str(HERE / 'validate-hook-report.py'))
```

3. In `node()`, replace the old conditional previous-report read with the
   following block, BEFORE deleting/replacing the `vf-custom` directory:

```python
previous = None
if MARK + ':hooks' in text:
    previous = HOOK_GATE['parse_hook_report'](
        (target / 'hooks-build.json').read_bytes()
    )
    HOOK_GATE['validate_hook_report'](previous)
```

An already-patched bundle with missing/invalid prior evidence must fail. A fresh
stock bundle has no marker and requires no previous report. For an older overlay
contract, rebuild from pinned stock instead of fabricating prior success.

4. Inside the already-patched branch, replace the old report merge with:

```python
if previous is not None:
    report.update({**previous['report'], **report})
```

This retains all prior Node/UI entries (including `node.bundle`, if present),
while freshly detected FFlow/GeoMap results take precedence. The old
`report.update(previous['report'])` could overwrite a NEW failed check with an
OLD `ok`. Keep the subsequent `note('node.bundle', True, 'already patched')`.
This merge does not convert any failure into success.

5. In `__main__`, AFTER all patching, syntax checks, and the FINAL
   `hooks-build.json` write, but BEFORE the existing success message and
   `sys.exit(0)`, retain the parent's checked subprocess gate:

```python
subprocess.run([sys.executable, str(HERE / 'validate-hook-report.py'),
                str(DIST / 'vf-custom' / 'hooks-build.json')], check=True)
```

An equivalent in-process call is
`HOOK_GATE['validate_hook_report_file'](DIST / 'vf-custom' / 'hooks-build.json')`.
Do not catch/log-and-continue in either form. Missing helper,
missing report, or a failed contract must terminate `RUN python3 .../apply.py`
with a nonzero code. Do not add this only to a CI step that an operator can omit.

6. Parent pins the Dockerfile default to the reviewed stock digest:

```dockerfile
ARG BASE=afflicted9436/tayzu31t3@sha256:f1e9c60fdfb3593d747bc3c2aa56bd8700a2c23f3706ba60459c282c6b520c67
FROM ${BASE}
```

Never use a prior custom image as `BASE` for an upstream update. Preserve the
stock layer and the separately versioned overlay (`node/`, `fflow/`, `ui/`,
installers and helper). The parent reports the candidate was rebuilt with this
mandatory gate. Record the resulting immutable image ID and verify that ID.
For subsequent changes rebuild under a new release reference and retain the
previous image.
Do not overwrite a tag already used as release evidence.

## Offline Verification

Run from the workspace root on the isolated builder where the candidate is
already available. Select the Docker context deliberately. The helper never
pulls an image. A remote Docker context still communicates with its configured
daemon; use a local builder context for a completely offline host. Do not select
a production daemon simply because it is the current Docker default.

```powershell
python -B scratch/vf-update-20261015/update-tools/verify_image.py local/vidforge-custom:20261015-27-upstream --docker-context desktop-linux --expected-version 2026.10.13.7 --report scratch/vf-update-20261015/update-tools/candidate-27-receipt.json
if ($LASTEXITCODE -ne 0) { throw 'Candidate rejected; do not deploy' }
```

`desktop-linux` is an example context, not a claim that this host has it. On
a Linux builder, use its explicitly selected isolated context (often `default`).
Use a new receipt filename for every attempt; existing receipts are never
overwritten. Command failure or missing/invalid receipt means no release.

What this command does:

- Resolves a local tag once with `docker image inspect`; subsequent operations
  use that exact `sha256:` image ID, so tag movement cannot change the candidate.
- Creates a uniquely named stopped container with `--pull=never`,
  `--network=none`, `--read-only`, `--restart=no`, and an overridden entrypoint.
  It NEVER starts it and has no production mounts, ports, or passed secrets.
- Copies only the native package, main bundle, custom modules/report, GeoMap
  JavaScript, and four custom UI scripts using `docker cp ... -` tar streams.
  Archives stay in memory; links, traversal, duplicates, and unexpected paths
  are rejected. No candidate file is extracted to or executed on the host.
- Validates all hooks and the native version in `/app/server/dist/index.mjs`.
  It finds exactly one native `/api/health` response returning the same symbol
  for `version` and `release_version`, resolves that symbol's single release
  initializer, and requires exactly one date-form release string in the bundle.
  On the actual staged stock bundle this is `Nk="2026.10.13.7"`; the symbol name
  is discovered, not hardcoded. Missing/changed anchors, duplicate assignments,
  ambiguous release strings, or a mismatched expected release fail closed.
  Package version is recorded separately as `package_version` (normally `1.0.0`).
  An OCI version label is optional; when present it must match the native BUNDLE
  release. Neither package metadata nor labels can substitute for bundle proof.
- Requires all 19 current custom Node modules and 8 main/GeoMap/UI scripts.
  Checks every required script plus any additional custom `.mjs/.cjs/.js` file
  with trusted host `node --check`, using module mode except for `.cjs`.
  It strips `NODE_*` environment overrides, never imports the candidate, and
  records Node version, file hashes, each syntax result, hooks, and image ID.
- Removes only its own stopped scratch container and its anonymous volumes.
  Cleanup failure is fatal. It never uses force removal, pruning, or compose.

Use a trusted Node version matching the candidate build runtime. These offline
checks use HOST Node; they do not prove runtime equivalence with a different
Node version inside the image. The installer's existing in-image Node checks
must remain enabled. Metadata JSON is not proof of actual runtime behavior;
all required behavior tests below are still a release prerequisite.

If interrupted during Docker create/copy, a stopped `vf-update-gate-<uuid>`
container may remain. Inspect ownership/state first and remove only that exact
scratch container with `docker rm --volumes <exact-name>`. Never prune broadly.

Validate an already-copied report without Docker or Node:

```powershell
python -B scratch/vf-update-20261015/update-tools/validate-hook-report.py path/to/hooks-build.json
if ($LASTEXITCODE -ne 0) { throw 'Hook report rejected' }
```

The validator also accepts `-` for JSON on stdin. Python callers can use
`runpy.run_path(...)['validate_hook_report_file'](path)` or importlib. Its import
does not invoke the CLI, execute candidate code, or access the network.

## Tests and Release Gates

Run the sidecar tests; no Docker daemon is contacted:

```powershell
python -B -m unittest discover -s scratch/vf-update-20261015/update-tools -p 'test_*.py' -v
if ($LASTEXITCODE -ne 0) { throw 'Gate tests failed' }
```

Real Node is required for the two syntax-parser tests. If either is skipped,
the suite is incomplete for release even if unittest exits zero. The contract
drift test only parses sibling `context/apply.py` as an AST; it never imports it.

Before releasing an upstream update, the parent must additionally verify:

1. A FRESH stock-plus-overlay build passes every required hook and syntax check
   with the fatal guard installed. Use a pinned stock digest and isolated build
   context. Preload required layers before offline work; do not let missing
   dependencies trigger unreviewed network work. `--network=none` constrains
   build steps, not image resolution; a strict offline build also needs a
   disconnected/local-only builder.
2. In an isolated disposable fixture, remove each required hook, add an unknown
   hook, and change one to `skipped:`. The final `__main__` guard MUST abort each
   case. Test the integrated installer, not only this helper.
3. Reapply on the disposable patched image: preserve the 34 required entries,
   allow `node.bundle: ok`, and prove a newly failed FFlow check is not overwritten
   by the previous report. Reject an already-patched bundle with no prior report.
4. Run the relevant existing overlay regressions in an isolated environment:
   queue/admission/priority limits; independent Home queues; transfer limits and
   CPU/GPU fallback; FFprobe/FFmpeg cleanup; AVC joins; GeoMap isolation; FX
   retention/sentinel; AI33 STT; Fish; sourcing deadlines; routing/retry controls;
   owner/CSRF API checks; Custom UI controls. No production queue or credentials.
   Use stubs/fixtures for provider and paid calls. Keep existing source-specific
   tests, do not replace them with only hook-name assertions.
5. Preserve native license/auth checks, schema/timings, queue limits, retention,
   settings, all hotfix source changes, and canonical local/server overlay parity.
   Archive hashes for all overlay Python/JS/UI files and actual live hotfixes;
   the 34-hook report alone does not prove that every source change survived.
6. Keep isolated smoke/runtime results separate from offline static results.
   Runtime testing needs independent data, blocked egress and no production
   secrets. Do not initialize against or mount the production database.

## Backup, Apply, Rollback

Preparation is not deployment authorization. Before an approved maintenance
window, create and independently verify a rollback set:

- Immutable current image ID/digest and a retained image archive or registry
  copy. A tag alone is not a backup; pruning has removed rollback tags before.
- Private compose/config/env source, current canonical overlay and LIVE code
  hashes. A hot-patched container can differ from its nominal image; account for
  those changes explicitly before calling the rollback image faithful.
- A consistent SQLite online backup with `PRAGMA quick_check` returning `ok`,
  plus the separately required media/assets backup. A raw copy of a live WAL
  database is not sufficient. Keep credentials in protected storage, not docs
  or public verification receipts.
- Queue IDs/states, script/payload/generation-snapshot hashes, relevant settings
  hashes, and worker/service state sufficient for an independent before/after
  comparison. Keep inventory private where it contains user data.

At apply time, recheck the verified image ID and all release receipts; stop on
any mismatch. Use the established service-specific deployment procedure only
after approval and a graceful queue/worker handoff. Change only VidForge's image
reference, not the shared stack or unrelated services. Never use a blanket
compose down/restart. Check native version, health, Custom/runtime hooks,
settings, job identities and payload/snapshot preservation after the change.
Normal job progress must be distinguished from lost or changed work.

For a code regression, stop further rollout and restore only the known-good
VidForge image/config under the same controlled handoff. Do NOT automatically
restore the older database over progressed work. If the upstream update made
incompatible DB/schema/retention changes, a code-only rollback is not enough:
stop and use the separately reviewed data-recovery plan. Never rerun/requeue
jobs or erase checkpoints to make rollback look successful.

## Evidence Boundaries

This sidecar's tests verify the validator, failure paths, safe Docker command
construction via a fake runner, archive handling, and real host Node parsing.
They do not attest that candidate 27 was inspected here or that any production
deployment occurred. The parent guard/Dockerfile integration was confirmed by
read-only source inspection, while the 34/34 candidate rebuild is parent-reported.
A fresh post-integration image receipt and integrated installer/runtime test
results are still required from the parent/operator.
