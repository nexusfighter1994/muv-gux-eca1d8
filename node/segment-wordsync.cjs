'use strict';
// HOT equivalent of segment-wordsync-install.py for an already-running process:
// the native fresh-render segment UPDATE (prepared per chunk) gets wordSyncVersion
// added to provider_outputs_json, exactly like the persisted writer fix.

const TARGET = 'UPDATE segments SET status = @status, output_path = @output_path, error = @error, attempt_count = @attempt_count, '
  + 'fallback_count = @fallback_count, provider_outputs_json = @provider_outputs_json, completed_at = @completed_at, '
  + 'updated_at = @updated_at WHERE id = @id';
const normalize = sql => String(sql).replace(/\s+/g, ' ').trim();

function withVersion(params, version) {
  if (!params || typeof params !== 'object' || typeof params.provider_outputs_json !== 'string') return params;
  try {
    const outputs = JSON.parse(params.provider_outputs_json);
    if (!outputs || typeof outputs !== 'object' || outputs.wordSyncVersion != null) return params;
    return { ...params, provider_outputs_json: JSON.stringify({ wordSyncVersion: version, ...outputs }) };
  } catch { return params; }
}

function wrapPrepare(db, { version = 3, stats = { statements: 0, writes: 0 } } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db.prepare required');
  if (db.prepare.__vfWordSync) return db.prepare.__vfWordSync;
  const original = db.prepare;
  const prepare = function (sql, ...rest) {
    const statement = Reflect.apply(original, this, [sql, ...rest]);
    // Cheap pre-check first: prepare() is called for every statement in the app.
    if (typeof sql !== 'string' || !sql.includes('provider_outputs_json = @provider_outputs_json') || normalize(sql) !== TARGET) return statement;
    stats.statements++;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'run') return params => { stats.writes++; return target.run(withVersion(params, version)); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  prepare.__vfWordSync = stats;
  prepare.original = original;
  db.prepare = prepare;
  return stats;
}

module.exports = { wrapPrepare, withVersion, TARGET };
