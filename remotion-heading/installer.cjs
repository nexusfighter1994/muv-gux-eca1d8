'use strict';
// Chart headings are never hidden by the spoken-text gate.
//
// Remotion infographics are wrapped in withSpokenText (utils/SpokenText.tsx), which hides
// every text-owning element (visibility:hidden) until a fuzzy transcript match says its
// words were spoken. The chart TITLE/SUBTITLE was gated too: "Rücklage nach zwölf Monaten"
// matched "über zwölf Monate" and stayed invisible until 3.68 s; a title paraphrased only
// after the cut never appeared at all. Headings are marked in Stage.tsx (Header) and
// un-gated after every gate pass. shared/spokenText.js stays untouched (hash-fenced by the
// infographic-timeline installer).
//
// --prebundle rebuilds the Remotion prebundle afterwards: every source change (including
// the infographic-timeline Timeline patch) otherwise makes the baked bundle "stale" and
// each render bundles webpack again.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARK = 'vf-custom:heading-never-gated-v1';
const STAGE_TITLE = '                key={`t${i}`}\n                style={{';
const STAGE_TITLE_NEW = '                key={`t${i}`}\n                data-vf-heading=""\n                style={{';
const STAGE_SUB = '      {layout.subtitle ? (\n        <div\n          style={{';
const STAGE_SUB_NEW = '      {layout.subtitle ? (\n        <div\n          data-vf-heading=""\n          style={{';
const GATE = '    React.useLayoutEffect(() => { gate.current?.(frame / fps); }, [frame, fps, words]);';
const GATE_NEW = '    React.useLayoutEffect(() => {\n'
  + '      gate.current?.(frame / fps);\n'
  + `      // ${MARK}: a chart title or subtitle is a heading, not a spoken label.\n`
  + "      root.current?.querySelectorAll('[data-vf-heading][data-vf-unspoken],[data-vf-heading] [data-vf-unspoken]')\n"
  + "        .forEach((el) => el.removeAttribute('data-vf-unspoken'));\n"
  + '    }, [frame, fps, words]);';

function once(text, anchor, what) {
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw Error(`Remotion heading anchor drift: ${what} (${n})`);
}

function patchStage(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const t = text.replace(/\r\n/g, '\n');
  if (t.includes('data-vf-heading')) {
    if (t.split('data-vf-heading=""').length - 1 !== 2) throw Error('Remotion heading marks partial in Stage.tsx');
    return text;
  }
  once(t, STAGE_TITLE, 'Stage title'); once(t, STAGE_SUB, 'Stage subtitle');
  return t.replace(STAGE_TITLE, STAGE_TITLE_NEW).replace(STAGE_SUB, STAGE_SUB_NEW).replace(/\n/g, nl);
}

function patchSpokenText(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const t = text.replace(/\r\n/g, '\n');
  if (t.includes(MARK)) { if (t.split(MARK).length - 1 !== 1) throw Error('Remotion heading gate duplicated'); return text; }
  once(t, GATE, 'SpokenText gate pass');
  return t.replace(GATE, GATE_NEW).replace(/\n/g, nl);
}

function files(root) {
  const base = path.join(root, 'render/remotion-engine/remotion');
  return { base, stage: path.join(base, 'src/infographic/Stage.tsx'), spoken: path.join(base, 'src/utils/SpokenText.tsx') };
}

function apply(root) {
  const f = files(root);
  const out = [[f.stage, patchStage(fs.readFileSync(f.stage, 'utf8'))], [f.spoken, patchSpokenText(fs.readFileSync(f.spoken, 'utf8'))]];
  for (const [p, s] of out) fs.writeFileSync(p + '.heading.tmp', s);
  for (const [p] of out) fs.renameSync(p + '.heading.tmp', p);
  return f;
}

function prebundle(root) {
  const { base } = files(root);
  execFileSync(process.execPath, ['prebundle.mjs'], { cwd: base, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  // The bundle must match the source on disk, or every render bundles again.
  const check = `import {computeSourceHash,findPrebundle} from './bundle-cache.mjs';const r=findPrebundle({sourceHash:computeSourceHash()});if(!r.dir){console.error('prebundle unusable: '+r.reason);process.exit(1)}`;
  execFileSync(process.execPath, ['--input-type=module', '-e', check], { cwd: base, stdio: 'inherit' });
}

module.exports = { patchStage, patchSpokenText, apply, prebundle, MARK };

if (require.main === module) {
  const args = process.argv.slice(2), at = args.indexOf('--root'), root = at >= 0 ? args[at + 1] : null;
  if (!root) throw Error('--root required');
  if (args.includes('--apply')) apply(root);
  if (args.includes('--prebundle')) prebundle(root);
  console.log(JSON.stringify({ heading: MARK, applied: args.includes('--apply'), prebundled: args.includes('--prebundle') }));
}
