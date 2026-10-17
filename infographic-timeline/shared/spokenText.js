// Render-only transcript matching, shared by Node, Remotion and HTML scenes.
// Keep these functions self-contained: HTML scenes embed their source verbatim.
export function spokenTextCue(text, words) {
  const tokens = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) || [];
  if (/^[\s$€£]*[\d,.]+\s*%?$/.test(String(text))) {
    const number = spokenNumberCue(Number(String(text).replace(/[^\d.]/g, '')), words);
    if (number) return number;
  }
  const wanted = tokens(text);
  if (!wanted.length) return null;
  const timeline = (words || []).flatMap(w => tokens(w.text ?? w.word).map(token => ({ token, start: Number(w.start), end: Number(w.end) }))).filter(w => Number.isFinite(w.start));
  let exact = null;
  for (let i = 0; i <= timeline.length - wanted.length; i++) {
    if (!wanted.every((t, j) => t === timeline[i + j].token)) continue;
    const hit = { start:timeline[i].start, end:timeline[i + wanted.length - 1].end };
    if (!exact || (hit.start >= 0 && exact.start < 0) || (hit.start < 0 && exact.start < 0 && hit.start > exact.start)) exact = hit;
  }
  if (exact) return exact;
  // Labels often paraphrase the narration. Prefer the most complete cluster,
  // rather than an earlier cluster that happens to contain half the words.
  // The server matcher's filler words (lib/spokenCues.js FILLER), minus German
  // "war", which is also the English noun. With English ones only, German
  // der/die/das counted as content: "Der Signal-Test" matched "Teste … der"
  // four seconds after the title was due.
  const filler = new Set('the and for from with that this into were was are has had its than been der die das den dem des ein eine einen einem einer und oder zum zur von vom mit für auf ist sind wurde les los las'.split(' '));
  const content = [...new Set(wanted.filter(t => t.length >= 3 && !filler.has(t)))];
  const same = (a, b) => a === b || (!/\d/.test(a + b) && Math.min(a.length, b.length) >= 4 && a.slice(0, Math.max(4, Math.ceil(Math.min(a.length, b.length) * .75))) === b.slice(0, Math.max(4, Math.ceil(Math.min(a.length, b.length) * .75))));
  const need = content.length === 1 ? 1 : Math.max(2, Math.ceil(content.length * .5));
  let best = null;
  for (let i = 0; i < timeline.length; i++) {
    if (!content.some(t => same(t, timeline[i].token))) continue;
    const hits = new Set(); let last = timeline[i];
    for (let j = i; j < timeline.length && timeline[j].start - timeline[i].start <= 4; j++) {
      const k = content.findIndex((t, k) => !hits.has(k) && same(t, timeline[j].token));
      if (k >= 0) { hits.add(k); last = timeline[j]; }
    }
    if (hits.size >= need && (!best || hits.size > best.matched)) {
      const first = timeline.slice(i).find(w => w.start <= last.start && same(content[0], w.token));
      best = { start:first?.start ?? timeline[i].start, end:last.end, matched:hits.size };
    }
  }
  return best;
}

/** English cardinal numbers, digit groups, and spoken years, with original
 * word bounds. A match must consume the whole contiguous number phrase:
 * "three thousand two hundred" cannot be mistaken for 3000. */
export function spokenNumberCue(value, words) {
  const small = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
  const scales = { thousand:1000, million:1000000, billion:1000000000 };
  const ts = (words || []).flatMap(w => String(w.text ?? w.word ?? '').toLowerCase().replace(/(?<=\d),(?=\d)/g, '').match(/[a-z]+|\d+(?:\.\d+)?/g)?.map(token => ({ token, start:Number(w.start), end:Number(w.end) })) || []);
  const isNumber = t => t in small || t in scales || t === 'hundred' || /^\d+(?:\.\d+)?$/.test(t);
  for (let i = 0; i < ts.length; i++) {
    if (!isNumber(ts[i].token)) continue;
    let j = i;
    while (j + 1 < ts.length && ts[j + 1].start - ts[j].end < .8 && (isNumber(ts[j + 1].token) || (ts[j + 1].token === 'and' && isNumber(ts[j + 2]?.token)))) j++;
    const group = ts.slice(i, j + 1).filter(t => t.token !== 'and');
    let total = 0, part = 0;
    for (const { token } of group) {
      if (token === 'hundred') part = (part || 1) * 100;
      else if (token in scales) { total += (part || 1) * scales[token]; part = 0; }
      else part += small[token] ?? Number(token);
    }
    const year = group.length >= 2 && (small[group[0].token] ?? 0) >= 10 && (small[group[0].token] ?? 100) <= 20 && !group.some(t => t.token in scales || t.token === 'hundred')
      ? small[group[0].token] * 100 + group.slice(1).reduce((n, t) => n + (small[t.token] ?? Number(t.token)), 0) : null;
    if (total + part === Number(value) || year === Number(value)) return { start:ts[i].start, end:ts[j].end };
    i = j;
  }
  return null;
}

// Gate only elements that directly own text; pictures, chart shapes and
// layout containers retain their authored choreography. No DOM restructuring
// or React-owned opacity/transform mutation. Seeking backwards restores gates.
// `placed` (HTML scenes, from retimeToSpeech) maps labels whose own animation
// now starts on their word to that entrance: they are gated there, never split
// into per-word cues, and keep it while a counter rewrites their text. With
// `placed`, every other label that waits for its word fades in over 0.3 s
// (SPOKEN_TEXT_FADE_CSS) instead of popping.
export function installSpokenTextGates(root, words, match = spokenTextCue, splitWords = false, placed = null) {
  const cache = new WeakMap();
  const placedCue = el => { if (placed) for (let p = el; p && p !== root; p = p.parentElement) if (placed.has(p)) return placed.get(p); return null; };
  if (splitWords) {
    // HTML scenes may already split a title into animated character spans.
    // Match their complete label once, then give every character its word's
    // cue. Literal unsplit labels receive inline spans, preserving layout and
    // the original parent that GSAP animates. React compositions never split.
    const doc = root.ownerDocument, scan = doc.createTreeWalker(root, 4), labels = new Set();
    while (scan.nextNode()) {
      let el = scan.currentNode.parentElement;
      if (!el || !scan.currentNode.textContent.trim() || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      while (el.parentElement && el.parentElement !== root && [...el.parentElement.childNodes].every(n => n.nodeType === 3 || (n.nodeType === 1 && /^(SPAN|TSPAN)$/.test(n.tagName)))) el = el.parentElement;
      labels.add(el);
    }
    for (const label of labels) {
      if (placedCue(label) || label.querySelector('img,svg,canvas,video')) continue;
      const text = label.textContent || '', cue = match(text, words);
      if (!cue) {
        // An unspoken label never waits, nor does any character of it: a
        // typed "Half" otherwise lost its "a" until the narrator said "a".
        const walker = doc.createTreeWalker(label, 4);
        while (walker.nextNode()) if (walker.currentNode.textContent.trim()) cache.set(walker.currentNode.parentElement, { text:walker.currentNode.textContent, cue:null });
        continue;
      }
      const scoped = words.filter(w => w.start >= Math.min(cue.start, cue.end) - 4 && w.start <= cue.end);
      const walker = doc.createTreeWalker(label, 4), nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      // Only a literal full phrase is split. Paraphrased labels retain their
      // authored markup, and existing character spans keep their identities.
      if (!cue.matched && nodes.length === 1 && /\s/.test(text) && label.namespaceURI !== 'http://www.w3.org/2000/svg') {
        const fragment = doc.createDocumentFragment();
        for (const part of text.split(/(\s+)/)) {
          if (!part.trim()) { fragment.appendChild(doc.createTextNode(part)); continue; }
          const span = doc.createElement('span'); span.textContent = part; fragment.appendChild(span);
        }
        nodes[0].replaceWith(fragment);
        nodes.length = 0; const split = doc.createTreeWalker(label, 4);
        while (split.nextNode()) nodes.push(split.currentNode);
      }
      const tokens = [...text.matchAll(/[\p{L}\p{N}]+/gu)]; let offset = 0;
      for (const node of nodes) {
        const token = tokens.find(t => t.index + t[0].length > offset) || tokens.at(-1);
        const wordCue = token ? match(token[0], scoped.filter(w => w.start >= cue.start)) : null;
        offset += node.textContent.length;
        if (node.textContent.trim()) cache.set(node.parentElement, { text:node.textContent, cue:wordCue || cue });
      }
    }
  }
  return (seconds) => {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    const parents = new Map();
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement;
      if (!el || !node.textContent.trim() || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
      parents.set(el, (parents.get(el) || '') + node.textContent);
    }
    for (const [el, text] of parents) {
      const fixed = placedCue(el);
      let entry = fixed ? { text, cue:fixed } : cache.get(el);
      if (!entry || entry.text !== text) { entry = { text, cue:match(text, words) }; cache.set(el, entry); }
      if (entry.cue && seconds + 1e-7 < entry.cue.start) {
        el.setAttribute('data-vf-unspoken', '');
        continue;
      }
      el.removeAttribute('data-vf-unspoken');
      if (!placed) continue;
      const reveal = entry.cue && !fixed ? (seconds - entry.cue.start) / .3 : 1;
      if (reveal < 1) { el.setAttribute('data-vf-revealing', ''); el.style.setProperty('--vf-reveal', Math.max(0, reveal).toFixed(3)); }
      else if (el.hasAttribute('data-vf-revealing')) { el.removeAttribute('data-vf-revealing'); el.style.removeProperty('--vf-reveal'); }
    }
  };
}

// HTML scenes (custom animations): move the choreography onto the narration
// instead of only hiding text. Templates put every move into the first 2-3 s,
// so with the gate alone a row's box and tick drew empty, nothing moved for
// seconds, and the text popped in on its word, sometimes a second before the
// cut (2026-10-05: 181 of 326 spoken labels in 235 production scenes).
//
// Every top-level tween of the scene timeline belongs to a label (the label,
// its word spans, a small sibling such as its box, tick, badge or leader line),
// to the label's group (the outermost small box around it: row, card, callout)
// or to the stage. Pictures, the camera and anything shared by several groups
// keep their authored time. A group enters when its first label is said,
// LEAD s before the word; a later label inside it waits for its own word. A
// label always gets HOLD s before the cut, leading its word if it must; a group
// said only after the cut is dropped rather than left empty. Unspoken groups
// keep the designed order (halfway between moved neighbours, or after the last
// one). Score bumps (plain-object tweens that rewrite a label) and reactions
// that start as an entrance lands (stamp shake, ring burst) move with it.
// Returns { placed: Map(label element -> { start }), report }, or null for a
// timeline it cannot read. Self-contained: the page embeds its source.
export function retimeToSpeech(timeline, root, words, duration, match, opts = {}) {
  if (!timeline || typeof timeline.getChildren !== 'function') return null;
  const LEAD = opts.lead ?? .15, HOLD = opts.hold ?? 1.1, TAIL = opts.tail ?? .3, GAP = .18, FOLLOW = .45;
  const D = Number(duration) || timeline.duration();
  const doc = root.ownerDocument, AREA = (doc.defaultView?.innerWidth || 1920) * (doc.defaultView?.innerHeight || 1080);
  const least = xs => xs.length ? Math.min(...xs) : null, most = xs => xs.length ? Math.max(...xs) : null;
  // The paper style wraps the scene timeline in one stepped tween.
  let host = timeline;
  for (let k = 0; k < 3; k++) {
    const kids = host.getChildren(false, true, true), inner = kids.length === 1 && kids[0].targets ? kids[0].targets()[0] : null;
    if (inner && typeof inner.getChildren === 'function') host = inner; else break;
  }
  const units = host.getChildren(false, true, true).map(u => {
    const unit = { u, start:u.startTime(), end:u.startTime() + u.totalDuration(), els:[], objs:[], kind:'stage' };
    for (const t of u.targets ? [u] : u.getChildren(true, true, false)) for (const x of t.targets()) (x && x.nodeType === 1 ? unit.els : unit.objs).push(x);
    return unit;
  });
  const seek = t => timeline.seek(t, false);
  const big = el => { const r = el.getBoundingClientRect(); return r.width * r.height > .3 * AREA; };
  const pic = el => /^(IMG|VIDEO|CANVAS|IMAGE)$/i.test(el.tagName) || !!el.querySelector?.('img,video,canvas,image');
  // Labels as the gate sees them, on the final frame.
  seek(D);
  const scan = doc.createTreeWalker(root, 4), found = new Set();
  while (scan.nextNode()) {
    let el = scan.currentNode.parentElement;
    if (!el || !scan.currentNode.textContent.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TITLE)$/.test(el.tagName)) continue;
    while (el.parentElement && el.parentElement !== root && [...el.parentElement.childNodes].every(n => n.nodeType === 3 || (n.nodeType === 1 && /^(SPAN|TSPAN)$/.test(n.tagName)))) el = el.parentElement;
    found.add(el);
  }
  const labels = [...found].map(el => ({ el, text:el.textContent, units:[], own:[], extra:0 }));
  const groups = new Map();
  for (const L of labels) {
    let box = L.el;
    for (let p = L.el.parentElement; p && p !== root && p !== doc.body && !big(p) && !pic(p); p = p.parentElement) box = p;
    if (!groups.has(box)) groups.set(box, { labels:[], units:[] });
    L.group = groups.get(box); L.group.labels.push(L);
  }
  const textsAt = t => { seek(t); return labels.map(L => L.el.textContent); };
  for (const unit of units) {
    if (unit.els.length || !unit.objs.length || unit.objs.some(o => typeof o.getChildren === 'function')) continue;
    const a = textsAt(Math.max(0, unit.start - .001)), b = textsAt(Math.min(D, unit.end));
    unit.writes = labels.filter((L, i) => a[i] !== b[i]);
  }
  seek(0);
  const labelOf = el => labels.reduce((best, L) => (L.el === el || L.el.contains(el)) && (!best || best.el.contains(L.el)) ? L : best, null);
  const labelsIn = el => labels.filter(L => L.el !== el && el.contains(L.el));
  const ownersOf = el => {
    const own = labelOf(el); if (own) return [own];
    for (let p = el; p && p !== root && p !== doc.body; p = p.parentElement) {
      if (pic(p) || big(p)) return null;
      const inside = labelsIn(p); if (inside.length) return inside;
    }
    return null;
  };
  const claim = (unit, L) => {
    unit.kind = 'label'; unit.label = L; L.units.push(unit);
    if (unit.writes?.includes(L) || unit.els.some(el => el === L.el || L.el.contains(el) || el.contains(L.el))) L.own.push(unit);
  };
  for (const unit of units) {
    if (!unit.els.length) continue;
    const owners = new Set();
    if (unit.els.some(el => { const o = ownersOf(el); o?.forEach(L => owners.add(L)); return !o; })) continue;
    const list = [...owners];
    if (list.length === 1) claim(unit, list[0]);
    else if (list.every(L => L.group === list[0].group)) { unit.kind = 'group'; list[0].group.units.push(unit); }
  }
  for (const unit of units.filter(u => u.writes?.length)) {
    const row = units.filter(o => o.kind === 'label' && !unit.writes.includes(o.label) && unit.start - o.start >= -.05 && unit.start - o.start <= .45)
      .sort((a, b) => Math.abs(unit.start - a.start) - Math.abs(unit.start - b.start))[0];
    if (row) claim(unit, row.label); else if (unit.writes.length === 1) claim(unit, unit.writes[0]);
  }
  for (const unit of units) {
    if (unit.kind !== 'stage' || !unit.els.length || unit.els.some(pic) || unit.end - unit.start > 1.2) continue;
    const cause = units.find(o => o.kind === 'label' && o.end - o.start > .05 && unit.start >= o.end - .03 && unit.start <= o.end + .12);
    if (cause) claim(unit, cause.label);
  }
  // Timing.
  for (const L of labels) {
    L.cue = match(L.text, words);
    const first = (L.own.length ? L.own : L.units).slice().sort((a, b) => a.start - b.start)[0];
    L.authored = first ? first.start : null;
    L.latest = D - HOLD - Math.min(.9, Math.max(.3, first ? first.end - first.start : .5)) / 2;
    L.state = !L.cue ? 'unspoken' : L.cue.start <= .05 ? 'said' : L.cue.start >= D - TAIL ? 'later' : 'spoken';
  }
  // Labels that take turns in one spot (a step-by-step scene's label and
  // step number, flip-card faces, myth → fact): the scene swaps them on its
  // own schedule, together with the pictures and progress around them.
  // Moved one by one onto their words, two of them stood on top of each
  // other ("Cigarette" over "Locker Room", 2026-10-09). They keep their
  // authored time and wait for their word only while their turn lasts, so a
  // late word never leaves a step without its label.
  const shown = new Map();
  for (const L of labels) {
    const mine = (L.own.length ? L.own : L.units).slice().sort((a, b) => a.start - b.start), first = mine[0];
    if (!first) continue;
    L.turnEnd = mine.find(u => u.start >= first.end - 1e-6)?.start ?? D;
    seek(Math.min(D, first.end));
    const r = L.el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) shown.set(L, r);
  }
  const shared = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 && w * h > .3 * Math.min(a.width * a.height, b.width * b.height);
  };
  const turns = [...shown];
  for (let i = 0; i < turns.length; i++) for (let j = i + 1; j < turns.length; j++) {
    const [A, ra] = turns[i], [B, rb] = turns[j];
    if (!A.el.contains(B.el) && !B.el.contains(A.el) && shared(ra, rb)) A.pinned = B.pinned = true;
  }
  seek(0);
  const all = [...groups.values()];
  for (const G of all) {
    G.all = [...G.units, ...G.labels.flatMap(L => L.units)];
    G.authored = least(G.all.map(u => u.start));
    G.delta = 0; G.mode = G.authored == null ? 'static' : G.labels.some(L => L.pinned) ? 'pinned' : 'keep';
    if (G.mode === 'static' || G.mode === 'pinned' || G.labels.some(L => L.state === 'said')) continue;
    const spoken = G.labels.filter(L => L.state === 'spoken' && L.authored != null).sort((a, b) => a.cue.start - b.cue.start);
    if (!spoken.length) {
      if (G.labels.some(L => L.state === 'later')) { G.mode = 'drop'; G.delta = D + 1 - G.authored; }
      else G.mode = 'unspoken';
      continue;
    }
    const lead = spoken[0], want = Math.min(lead.cue.start - LEAD, lead.latest);
    G.clamped = want < lead.cue.start - LEAD - 1e-6;
    G.delta = Math.max(Math.max(want, Math.min(lead.authored, .3)) - lead.authored, -G.authored);
    if (Math.abs(G.delta) < .12) G.delta = 0; else G.mode = 'shift';
  }
  for (const G of all) {
    if (G.mode === 'drop' || G.mode === 'static' || G.mode === 'pinned') continue;
    let prev = null;
    for (const L of G.labels.filter(L => L.authored != null).sort((a, b) => a.authored - b.authored)) {
      const base = L.authored + G.delta;
      if (L.state === 'spoken') { const want = Math.min(L.cue.start - LEAD, L.latest); if (want > base + .12) L.extra = want - base; }
      else if (L.state === 'later') L.extra = D + 1 - base;
      else if (L.state === 'unspoken' && prev != null && prev + GAP > base) L.extra = Math.min(prev + GAP, Math.max(L.latest, base)) - base;
      L.start = L.state === 'later' ? null : base + L.extra;
      if (L.start != null) prev = L.start;
    }
  }
  const firstOf = G => least(G.labels.filter(L => L.start != null).map(L => L.start));
  const lastOf = G => most(G.labels.filter(L => L.start != null).map(L => L.start));
  const seq = all.filter(G => G.authored != null && G.mode !== 'drop').sort((a, b) => a.authored - b.authored);
  seq.forEach((G, i) => {
    const prev = seq[i - 1];
    if (G.mode !== 'unspoken' || !prev || !(prev.mode === 'shift' || prev.labels.some(L => L.extra > 0))) return;
    const after = lastOf(prev), next = seq.slice(i + 1).find(n => n.mode !== 'unspoken');
    if (after == null || after <= G.authored + .12) return;
    let want = !next ? after + FOLLOW : next.mode === 'shift' && firstOf(next) > after ? (after + firstOf(next)) / 2 : null;
    if (want == null) return;
    want = Math.min(want, Math.max(least(G.labels.map(L => L.latest)), G.authored));
    if (want <= G.authored + .12) return;
    G.mode = 'follow'; G.delta = want - G.authored;
    for (const L of G.labels) if (L.start != null) L.start += G.delta;
  });
  // Groups clamped against the cut keep their spoken order.
  const moved = all.filter(G => G.mode === 'shift').sort((a, b) => firstOf(a) - firstOf(b));
  for (let i = 1; i < moved.length; i++) {
    const gap = firstOf(moved[i - 1]) + GAP - firstOf(moved[i]);
    if (moved[i].clamped && gap > 0) { moved[i].delta += gap; for (const L of moved[i].labels) if (L.start != null) L.start += gap; }
  }
  if (!opts.dry) {
    for (const G of all) {
      if (G.delta) for (const unit of G.all) unit.u.startTime(unit.u.startTime() + G.delta);
      for (const L of G.labels) if (L.extra) for (const unit of L.units) unit.u.startTime(unit.u.startTime() + L.extra);
    }
    seek(0);
  }
  const placed = new Map();
  for (const L of labels) {
    if (L.authored == null) continue;
    if (L.group.mode === 'pinned') { const word = L.cue && L.state !== 'later' ? L.cue.start : -Infinity; placed.set(L.el, { start:Math.max(L.authored, Math.min(word, L.turnEnd - .8)) }); continue; }
    if (L.group.mode === 'drop' || L.state === 'later') placed.set(L.el, { start:Infinity });
    else if (L.state === 'said') placed.set(L.el, { start:0 });
    else if (L.state === 'spoken') placed.set(L.el, { start:Math.min(L.start, L.cue.start) });
  }
  const mode = L => L.group.mode === 'pinned' ? 'pinned' : L.group.mode === 'drop' || L.state === 'later' ? 'drop' : L.authored == null ? 'static' : L.extra || L.group.delta ? (L.group.mode === 'follow' ? 'follow' : 'moved') : 'kept';
  return { placed, report:{ duration:D, labels:labels.map(L => ({ text:L.text.slice(0, 60), cue:L.cue ? { start:L.cue.start, end:L.cue.end } : null, authored:L.authored, start:L.start ?? null, mode:mode(L) })) } };
}

export const SPOKEN_TEXT_CSS = '[data-vf-unspoken]{visibility:hidden!important}';
// The 0.3 s reveal of a label the retimer could not move: a mask and the
// separate translate property, because GSAP owns opacity and transform.
export const SPOKEN_TEXT_FADE_CSS = '[data-vf-revealing]{-webkit-mask-image:linear-gradient(rgba(0,0,0,var(--vf-reveal)),rgba(0,0,0,var(--vf-reveal)));mask-image:linear-gradient(rgba(0,0,0,var(--vf-reveal)),rgba(0,0,0,var(--vf-reveal)));translate:0 calc((1 - var(--vf-reveal)) * 16px)}';
