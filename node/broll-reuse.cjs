'use strict';
// Resume safety for rendered B-roll video segments.
//
// 1. Native o0s reuse check E() rebuilds the b_roll_video final_video input as
//    {best,durationSec,outputPath,creditAuthor} only, but uBn really hashes
//    `verify` (footage text check, on by default) and `window`/`slow` (slow-to-fit or
//    extended windows) as well. So every rendered B-roll video looked stale on any
//    retry/restart, was re-rendered, and its selected_source checkpoint (hashed with
//    the whole segment row) was deleted -> B-roll searched and downloaded again.
//    finalMatches() recognises exactly the inputs uBn builds for the same pick.
// 2. stableSegmentInput(): the selected_source input carries the segment DB row,
//    whose bookkeeping columns change on every attempt. Only the planned content
//    may decide whether a stored pick still applies.

const VOLATILE = ['status', 'output_path', 'error', 'attempt_count', 'fallback_count',
  'provider_outputs_json', 'started_at', 'completed_at', 'created_at', 'updated_at'];

function stableSegmentInput(segment) {
  if (!segment || typeof segment !== 'object') return segment;
  const copy = { ...segment };
  for (const key of VOLATILE) delete copy[key];
  return copy;
}

function windowVariants({ best, durationSec, output, fit }) {
  const out = [{}];
  const seen = new Set(['{}']);
  const add = v => { const k = JSON.stringify(v); if (!seen.has(k)) { seen.add(k); out.push(v); } };
  for (const allowSlow of [true, false]) {
    let fitPlan = null;
    try { fitPlan = typeof fit === 'function' ? fit(best, durationSec, allowSlow) : null; } catch { fitPlan = null; }
    if (fitPlan && (fitPlan.extended || fitPlan.slowed)) {
      add({ window: { startSec: fitPlan.startSec, endSec: fitPlan.endSec }, ...(fitPlan.slowed ? { slow: fitPlan.slowFactor } : {}) });
    }
  }
  // The primary pick's real window is also recorded in the final output.
  if (output && !output.repicked && Number.isFinite(output.usedStartSec) && Number.isFinite(output.usedEndSec)) {
    const window = { startSec: output.usedStartSec, endSec: output.usedEndSec };
    add({ window });
    const span = Number(best?.endSec) - Number(best?.startSec), d = Number(durationSec);
    if (span > 0 && d > 0) add({ window, slow: Math.round(d / span * 1e4) / 1e4 });
  }
  return out;
}

function finalInputs({ best, durationSec, outputPath, creditAuthor, output = null, fit = null, verify = 1 }) {
  const inputs = [];
  for (const w of windowVariants({ best, durationSec, output, fit })) {
    for (const v of [undefined, verify ?? 1]) {
      inputs.push({ best, durationSec, outputPath, creditAuthor, ...w, ...(v === undefined ? {} : { verify: v }) });
    }
  }
  return inputs;
}

function finalMatches({ hash, GM, ...rest }) {
  if (typeof hash !== 'string' || typeof GM !== 'function' || !rest.best) return false;
  return finalInputs(rest).some(input => GM(input) === hash);
}

// Persisted hook (broll-reuse-install.py), called inside native E() after its own
// exact check failed. Only the current creditAuthor counts, like native.
const stats = { checked: 0, reused: 0 };
function brollFinalReuse({ hash, GM, best, durationSec, outputPath, creditAuthor, outputJson = null, fit = null, verify = 1 }) {
  stats.checked++;
  let output = null;
  try { output = outputJson ? JSON.parse(outputJson) : null; } catch { output = null; }
  const ok = finalMatches({ hash, GM, best, durationSec, outputPath, creditAuthor, output, fit, verify });
  if (ok) stats.reused++;
  return ok;
}

// HOT equivalent for an already-running process: E() prepares this exact statement on
// every call. A final_video row whose stored hash is a real uBn variant is returned with
// the canonical hash native E() computes, for the creditAuthor it was rendered with
// (a changed credit setting still re-renders, like native).
const TARGET = "SELECT operation, input_hash, output_json FROM operation_checkpoints WHERE job_id = ? AND scope_type = 'segment' "
  + "AND scope_id = ? AND namespace = ? AND operation IN ('selected_source', 'final_video', 'treatment') AND status = 'succeeded'";
const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();

function adjustRows(rows, [, scopeId, namespace], { GM, fit, verify, segment, stats: s }) {
  if (namespace !== 'b_roll_video' || !Array.isArray(rows)) return rows;
  const F = rows.find(r => r.operation === 'selected_source'), z = rows.find(r => r.operation === 'final_video');
  if (!F || !z) return rows;
  let best = null, output = null;
  try { best = JSON.parse(F.output_json || 'null'); output = JSON.parse(z.output_json || 'null'); } catch { return rows; }
  if (!best) return rows;
  const row = segment(scopeId);
  if (!row) return rows;
  let O = {};
  try { O = JSON.parse(row.provider_outputs_json || '{}') || {}; } catch { O = {}; }
  const durationSec = row.duration_sec;
  const outputPath = O.subjectFocus?.baseOutputPath || O.smartOverlay?.baseOutputPath || row.output_path;
  if (!outputPath) return rows;
  s.checked++;
  for (const creditAuthor of [true, false]) {
    const canonical = GM({ best, durationSec, outputPath, creditAuthor });
    if (z.input_hash === canonical) return rows;
    if (finalMatches({ hash: z.input_hash, GM, best, durationSec, outputPath, creditAuthor, output, fit, verify })) {
      s.normalized++;
      return rows.map(r => (r === z ? { ...r, input_hash: canonical } : r));
    }
  }
  return rows;
}

function wrapPrepare(db, { GM, fit = null, verify = 1, stats: s = { statements: 0, checked: 0, normalized: 0 } } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db.prepare required');
  if (typeof GM !== 'function') throw new TypeError('GM required');
  if (db.prepare.__vfBrollReuse) return db.prepare.__vfBrollReuse;
  const original = db.prepare;
  let segmentStatement = null;
  const segment = id => {
    segmentStatement ??= Reflect.apply(original, db, ['SELECT duration_sec, output_path, provider_outputs_json FROM segments WHERE id = ?']);
    return segmentStatement.get(id);
  };
  const prepare = function (sql, ...rest) {
    const statement = Reflect.apply(original, this, [sql, ...rest]);
    // Cheap pre-check first: prepare() is called for every statement in the app.
    if (typeof sql !== 'string' || !sql.includes("'final_video', 'treatment'") || normalize(sql) !== TARGET) return statement;
    s.statements++;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'all') return (...args) => {
          const rows = target.all(...args);
          try { return adjustRows(rows, args, { GM, fit, verify, segment, stats: s }); } catch { return rows; }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  prepare.__vfBrollReuse = s;
  prepare.original = original;
  db.prepare = prepare;
  return s;
}

module.exports = { stableSegmentInput, finalInputs, finalMatches, brollFinalReuse, wrapPrepare, adjustRows, stats, TARGET, VOLATILE };
