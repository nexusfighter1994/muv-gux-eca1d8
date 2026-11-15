'use strict';
const { diffArrays } = require('./vendor/jsdiff-9.0.0/diff.cjs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread && workerData?.kind === 'source-text-diff') {
  const changes = diffArrays(workerData.source, workerData.target, workerData.options);
  parentPort.postMessage({ changes });
}
let workersActive = 0;
async function isolatedDiff(source, target, { signal, checkAbort, timeoutMs, maxEditLength }) {
  if (workersActive >= 2) throw refused('alignment worker capacity exhausted');
  workersActive++;
  let worker;
  try {
    worker = new Worker(__filename, { workerData: { kind: 'source-text-diff', source, target,
      options: { timeout: Math.min(15000, Math.max(1, timeoutMs)), maxEditLength: Math.min(8000, Math.max(0, maxEditLength)) } },
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(refused('alignment worker deadline exhausted')), Math.min(30000, Math.max(1, timeoutMs)));
      const poll = setInterval(() => { try { checkAbort?.(); } catch (e) { reject(e); } }, 500);
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', message => resolve(message.changes));
      worker.once('error', reject);
      worker.once('exit', code => reject(refused('alignment worker exited ' + code)));
      worker.__cleanup = () => { clearTimeout(timer); clearInterval(poll); signal?.removeEventListener('abort', abort); };
    });
  } finally {
    worker?.__cleanup?.();
    try { if (worker) await worker.terminate(); }
    finally { workersActive--; }
  }
}
const LOCALES = { Japanese: 'ja', Korean: 'ko', Chinese: 'zh', 'Mandarin Chinese': 'zh' };
const round = n => Math.round(n * 1000) / 1000;
function refused(reason) { return Error('Source text alignment repair refused: ' + reason); }
function graphemes(text, segmenter) {
  const normalized = String(text ?? '').normalize('NFKC').replace(/[\p{White_Space}\p{P}]/gu, '');
  return Array.from(segmenter.segment(normalized), x => x.segment);
}

async function repairSourceTimeline({ aligned, words, scriptChunks, language, durationSeconds,
  partition, signal, checkAbort, onRepair, timeoutMs = 30000, maxEditLength = 8000 }) {
  try { partition(aligned, durationSeconds); return aligned; }
  catch (e) {
    if (!String(e?.message).startsWith('partitionSourceTimelineCuts: invalid/non-monotonic boundary before chunk ')) return aligned;
  }
  const locale = LOCALES[language];
  if (!locale) return aligned;
  checkAbort?.();
  signal?.throwIfAborted();
  if (!Array.isArray(words) || !Array.isArray(scriptChunks) || scriptChunks.length !== aligned.length ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw refused('invalid input');
  const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  const scripts = [...scriptChunks].sort((a, b) => a.chunk_number - b.chunk_number);
  const source = [], target = [], scriptStarts = [], targetWords = [];
  for (const c of scripts) {
    scriptStarts.push(source.length);
    const chars = graphemes(c.script_chunk, segmenter);
    if (!chars.length) throw refused('empty script chunk');
    source.push(...chars);
  }
  let lastStart = -Infinity;
  words.forEach((w, i) => {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start ||
        w.start < lastStart || w.end > durationSeconds + .1) throw refused('invalid transcript timestamp');
    lastStart = w.start;
    const chars = graphemes(w.text, segmenter);
    target.push(...chars);
    for (const _ of chars) targetWords.push(i);
  });
  if (!source.length || !target.length || Math.max(source.length, target.length) > 100000 ||
      Math.abs(source.length - target.length) / Math.max(source.length, target.length) > .2)
    throw refused('text length mismatch or limit');

  // Keep bounded text work off the busy API event loop; terminate and release on every outcome.
  const changes = await isolatedDiff(source, target, { signal, checkAbort, timeoutMs, maxEditLength });
  signal?.throwIfAborted();
  if (!changes) throw refused('diff work/time budget exhausted');
  checkAbort?.();
  const matched = changes.filter(c => !c.added && !c.removed).reduce((n, c) => n + c.count, 0);
  if (matched / Math.max(source.length, target.length) < .8) throw refused('insufficient matching text');

  const offsets = new Map();
  let s = 0, t = 0, boundary = 0;
  for (let i = 0; i < changes.length;) {
    const c = changes[i];
    if (!c.added && !c.removed) {
      while (boundary < scriptStarts.length && scriptStarts[boundary] < s + c.count) {
        offsets.set(boundary, t + scriptStarts[boundary] - s); boundary++;
      }
      s += c.count; t += c.count; i++;
      continue;
    }
    let removed = 0, added = 0;
    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const edit = changes[i++];
      if (edit.removed) removed += edit.count;
      else added += edit.count;
    }
    // Interpolate only short substitutions bounded by actual text matches, never the entire audio.
    while (boundary < scriptStarts.length && scriptStarts[boundary] < s + removed) {
      if (Math.max(removed, added) > 64 || s === 0 || s + removed === source.length)
        throw refused('unanchored chunk boundary');
      offsets.set(boundary, t + Math.floor((scriptStarts[boundary] - s) * added / removed)); boundary++;
    }
    s += removed; t += added;
  }
  if (offsets.size !== scripts.length) throw refused('missing text anchors');
  const starts = scripts.map((_, i) => targetWords[offsets.get(i)]);
  if (starts.some((x, i) => !Number.isInteger(x) || (i > 0 && x <= starts[i - 1])))
    throw refused('collapsed word boundary');
  const repaired = aligned.map((cut, i) => {
    if (Number(cut.chunk_number) !== Number(scripts[i].chunk_number)) throw refused('chunk order mismatch');
    const endWord = i + 1 < starts.length ? starts[i + 1] - 1 : words.length - 1;
    return { ...cut, start_time: i === 0 ? 0 : round(Math.max(0, words[starts[i]].start - .03)),
      end_time: round(words[endWord].end + (i + 1 < starts.length ? .02 : 0)) };
  });
  // The unmodified native validator remains the authority for source coverage and positive cuts.
  partition(repaired, durationSeconds);
  signal?.throwIfAborted();
  checkAbort?.();
  onRepair?.({ algorithm: 'bounded_grapheme_diff', chunks: repaired.length,
    scriptGraphemes: source.length, transcriptGraphemes: target.length, matched });
  return repaired;
}
module.exports = { repairSourceTimeline };
