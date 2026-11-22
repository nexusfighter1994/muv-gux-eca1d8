'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../node/long-video-cap.cjs');

// Tiny in-memory stand-in for the three statements the module uses.
function fakeDb(jobs) {
  return {
    jobs,
    prepare(sql) {
      return {
        get: id => { const j = jobs.find(x => x.id === id); return j ? { payload_json: j.payload_json } : undefined; },
        all: () => {
          if (sql.includes('FROM chunks')) {
            if (jobs.chunksBroken) throw new Error('no such table: chunks');
            return jobs.filter(j => j.status === 'queued' && j.saved).map(j => ({ job_id: j.id }));
          }
          if (sql.includes("status IN ('running', 'pausing')")) return jobs.filter(j => j.status === 'running').map(j => ({ id: j.id }));
          return jobs.filter(j => j.status === 'queued')
            .map((j, i) => ({ j, i })).sort((a, b) => String(a.j.queued_at || '').localeCompare(String(b.j.queued_at || '')) || a.i - b.i)
            .map(({ j }) => ({ id: j.id, available_at: j.available_at, queued_at: j.queued_at }));
        },
        run: (...args) => {
          if (sql.includes('SET queued_at')) {
            const [stamp, updated, id] = args; const j = jobs.find(x => x.id === id && x.status === 'queued');
            if (j) { j.queued_at = stamp; j.updated_at = updated; } return { changes: j ? 1 : 0 };
          }
          if (sql.includes('available_at = NULL')) {
            const [id, prev] = args; const j = jobs.find(x => x.id === id && x.status === 'queued' && x.available_at === prev);
            if (j) j.available_at = null; return { changes: j ? 1 : 0 };
          }
          const [stamp, id, prev] = args; const j = jobs.find(x => x.id === id && x.status === 'queued' && (x.available_at === null || x.available_at === prev));
          if (j) j.available_at = stamp; return { changes: j ? 1 : 0 };
        },
      };
    },
  };
}
const words = n => JSON.stringify({ customScript: Array(n).fill('w').join(' ') });
const job = (id, status, n, available_at = null) => ({ id, status, payload_json: words(n), available_at });
const cfg = over => () => ({ ...C.DEFAULTS, ...over });

test('holds queued long videos while the cap is reached, short ones stay free', () => {
  const jobs = [job('r1', 'running', 20000), job('r2', 'running', 20000), job('r3', 'running', 2000),
    job('q1', 'queued', 25000), job('q2', 'queued', 1500), job('q3', 'queued', 26000)];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 2 }), now: () => Date.parse('2026-11-18T13:00:00Z'), log: () => {} });
  const s = cap.tick();
  assert.strictEqual(s.longRunning, 2);
  assert.ok(C.isOurHold(jobs[3].available_at)); assert.ok(C.isOurHold(jobs[5].available_at));
  assert.strictEqual(jobs[4].available_at, null);
  assert.strictEqual(s.held, 2);
});

test('releases exactly the free long slots in queue order and wakes the dispatcher', () => {
  const jobs = [job('r1', 'running', 20000), job('q1', 'queued', 25000, '2026-11-18T13:05:00.987Z'),
    job('q2', 'queued', 26000, '2026-11-18T13:05:00.987Z'), job('q3', 'queued', 27000, '2026-11-18T13:05:00.987Z')];
  let woke = 0;
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 3 }), now: () => Date.parse('2026-11-18T13:01:00Z'), dispatch: () => { woke++; }, log: () => {} });
  const s = cap.tick();
  assert.strictEqual(jobs[1].available_at, null); assert.strictEqual(jobs[2].available_at, null);
  assert.ok(C.isOurHold(jobs[3].available_at));
  assert.strictEqual(s.released, 2); assert.strictEqual(woke, 1);
});

test('never touches a schedule that is not ours', () => {
  const jobs = [job('r1', 'running', 20000), job('q1', 'queued', 25000, '2026-11-18T15:00:00.000Z')];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 1 }), now: () => Date.parse('2026-11-18T13:00:00Z'), log: () => {} });
  cap.tick();
  assert.strictEqual(jobs[1].available_at, '2026-11-18T15:00:00.000Z');
  const cap2 = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 5 }), now: () => Date.parse('2026-11-18T13:00:00Z'), log: () => {} });
  cap2.tick();
  assert.strictEqual(jobs[1].available_at, '2026-11-18T15:00:00.000Z');
});

test('refreshes a hold only when half of it has passed; disabled releases everything', () => {
  const jobs = [job('r1', 'running', 20000), job('q1', 'queued', 25000, '2026-11-18T13:09:00.987Z')];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 1 }), now: () => Date.parse('2026-11-18T13:00:00Z'), log: () => {} });
  cap.tick();
  assert.strictEqual(jobs[1].available_at, '2026-11-18T13:09:00.987Z');
  const later = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 1 }), now: () => Date.parse('2026-11-18T13:06:00Z'), log: () => {} });
  later.tick();
  assert.strictEqual(jobs[1].available_at, '2026-11-18T13:16:00.987Z');
  const off = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 1, enabled: false }), now: () => Date.parse('2026-11-18T13:07:00Z'), log: () => {} });
  off.tick();
  assert.strictEqual(jobs[1].available_at, null);
});

test('config reader keeps defaults for bad values', () => {
  const c = C.readConfig('/x', () => '{"maxLong":"abc","longWords":6000,"enabled":false}');
  assert.strictEqual(c.maxLong, 5); assert.strictEqual(c.longWords, 6000); assert.strictEqual(c.enabled, false);
  assert.strictEqual(C.readConfig('/missing', () => { throw new Error('x'); }).maxLong, 5);
  assert.strictEqual(C.scriptWords(JSON.stringify({ customScript: 'a b  c\n d' })), 4);
});

// 2026-11-20: videos that were already running (saved work in `chunks`) are never parked behind the cap.
const saved = j => ({ ...j, saved: true });

test('a re-queued long video with saved work is released although the cap is full', () => {
  const jobs = [job('r1', 'running', 20000), job('r2', 'running', 20000),
    saved(job('back', 'queued', 21000, '2026-11-20T12:05:00.987Z')), job('fresh', 'queued', 25000), job('short', 'queued', 1500)];
  let woke = 0;
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 2 }), now: () => Date.parse('2026-11-20T12:00:00Z'), dispatch: () => { woke++; }, log: () => {} });
  const s = cap.tick();
  assert.strictEqual(jobs[2].available_at, null, 'resuming video must be startable');
  assert.ok(C.isOurHold(jobs[3].available_at), 'fresh long video stays held');
  assert.strictEqual(jobs[4].available_at, null);
  assert.strictEqual(s.resuming, 1); assert.strictEqual(s.held, 1); assert.strictEqual(s.released, 1); assert.strictEqual(woke, 1);
  cap.tick();
  assert.strictEqual(jobs[2].available_at, null, 'and is not held again on the next tick');
});

test('a resuming video takes a long slot: fewer fresh long videos are released', () => {
  const jobs = [job('r1', 'running', 20000), saved(job('back', 'queued', 21000)),
    job('f1', 'queued', 25000, '2026-11-20T12:05:00.987Z'), job('f2', 'queued', 26000, '2026-11-20T12:05:00.987Z')];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 3 }), now: () => Date.parse('2026-11-20T12:00:00Z'), log: () => {} });
  cap.tick();
  assert.strictEqual(jobs[1].available_at, null);
  assert.strictEqual(jobs[2].available_at, null, '3 slots - 1 running - 1 resuming = 1 fresh');
  assert.ok(C.isOurHold(jobs[3].available_at));
});

test('saved work does not matter for short videos or foreign schedules', () => {
  const jobs = [job('r1', 'running', 20000), saved(job('s', 'queued', 1500)), saved(job('sched', 'queued', 22000, '2026-11-21T08:00:00.000Z')),
    job('fresh', 'queued', 25000)];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 2 }), now: () => Date.parse('2026-11-20T12:00:00Z'), log: () => {} });
  const s = cap.tick();
  assert.strictEqual(jobs[1].available_at, null);
  assert.strictEqual(jobs[2].available_at, '2026-11-21T08:00:00.000Z', 'owner schedule untouched');
  assert.strictEqual(s.resuming, 0);
  assert.strictEqual(jobs[3].available_at, null, 'the scheduled one does not eat a long slot');
});

test('resumeExempt off or a failing chunks lookup gives the old behaviour', () => {
  const mk = () => [job('r1', 'running', 20000), saved(job('back', 'queued', 21000))];
  const off = mk();
  C.createLongVideoCap({ db: fakeDb(off), read: cfg({ maxLong: 1, resumeExempt: false }), now: () => Date.parse('2026-11-20T12:00:00Z'), log: () => {} }).tick();
  assert.ok(C.isOurHold(off[1].available_at));
  const broken = mk(); broken.chunksBroken = true;
  const s = C.createLongVideoCap({ db: fakeDb(broken), read: cfg({ maxLong: 1 }), now: () => Date.parse('2026-11-20T12:00:00Z'), log: () => {} }).tick();
  assert.ok(C.isOurHold(broken[1].available_at)); assert.strictEqual(s.lastError, null);
  assert.strictEqual(C.readConfig('/x', () => '{"resumeExempt":false}').resumeExempt, false);
  assert.strictEqual(C.readConfig('/x', () => '{}').resumeExempt, true);
});

// 2026-11-20: videos with saved work go in front of the fresh ones (resumeFront).
const at = (j, queued_at) => ({ ...j, queued_at });
const order = jobs => jobs.filter(j => j.status === 'queued').slice().sort((a, b) => String(a.queued_at).localeCompare(String(b.queued_at))).map(j => j.id);

test('a re-queued video with saved work moves in front of fresh videos and is not moved again', () => {
  const jobs = [job('r1', 'running', 2000),
    at(job('f1', 'queued', 1500), '2026-11-19T16:08:27.006Z'), at(job('f2', 'queued', 25000), '2026-11-19T16:08:28.006Z'),
    at(saved(job('back', 'queued', 21000)), '2026-11-20T14:03:25.833Z'), at(job('f3', 'queued', 1800), '2026-11-20T14:03:26.000Z')];
  let woke = 0; const logs = [];
  const cap = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 5 }), now: () => Date.parse('2026-11-20T17:06:30Z'), dispatch: () => { woke++; }, log: m => logs.push(m) });
  const s = cap.tick();
  assert.deepStrictEqual(order(jobs), ['back', 'f1', 'f2', 'f3']);
  assert.strictEqual(jobs[3].queued_at, '2026-11-19T16:08:26.006Z');
  assert.strictEqual(s.movedFront, 1); assert.strictEqual(woke, 1); assert.match(logs.join('\n'), /moved 1 video/);
  const again = cap.tick();
  assert.strictEqual(again.movedFront, 1, 'no second move'); assert.strictEqual(jobs[3].queued_at, '2026-11-19T16:08:26.006Z');
});

test('several videos with saved work keep their own order; short ones are moved too', () => {
  const jobs = [at(saved(job('a', 'queued', 1500)), '2026-11-19T10:00:00.000Z'), at(job('f1', 'queued', 1500), '2026-11-19T11:00:00.000Z'),
    at(saved(job('b', 'queued', 22000)), '2026-11-19T12:00:00.000Z'), at(job('f2', 'queued', 1500), '2026-11-19T13:00:00.000Z'),
    at(saved(job('c', 'queued', 900)), '2026-11-19T14:00:00.000Z')];
  C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 5 }), now: () => Date.parse('2026-11-20T17:00:00Z'), log: () => {} }).tick();
  assert.deepStrictEqual(order(jobs), ['a', 'b', 'c', 'f1', 'f2']);
});

test('nothing moves when saved work is already in front, scheduled, held by a switched-off exemption, or resumeFront is off', () => {
  const front = [at(saved(job('a', 'queued', 21000)), '2026-11-19T10:00:00.000Z'), at(job('f1', 'queued', 1500), '2026-11-19T11:00:00.000Z')];
  assert.strictEqual(C.createLongVideoCap({ db: fakeDb(front), read: cfg({ maxLong: 5 }), now: () => Date.parse('2026-11-20T17:00:00Z'), log: () => {} }).tick().movedFront, 0);
  const sched = [at(job('f1', 'queued', 1500), '2026-11-19T11:00:00.000Z'), at(saved(job('s', 'queued', 21000, '2026-11-21T08:00:00.000Z')), '2026-11-19T12:00:00.000Z')];
  assert.strictEqual(C.createLongVideoCap({ db: fakeDb(sched), read: cfg({ maxLong: 5 }), now: () => Date.parse('2026-11-20T17:00:00Z'), log: () => {} }).tick().movedFront, 0);
  assert.strictEqual(sched[1].queued_at, '2026-11-19T12:00:00.000Z');
  const mk = () => [job('r1', 'running', 20000), at(job('f1', 'queued', 1500), '2026-11-19T11:00:00.000Z'), at(saved(job('b', 'queued', 21000)), '2026-11-19T12:00:00.000Z')];
  const noExempt = mk();
  assert.strictEqual(C.createLongVideoCap({ db: fakeDb(noExempt), read: cfg({ maxLong: 1, resumeExempt: false }), now: () => Date.parse('2026-11-20T17:00:00Z'), log: () => {} }).tick().movedFront, 0,
    'held by the cap: moving it would not help');
  const off = mk();
  assert.strictEqual(C.createLongVideoCap({ db: fakeDb(off), read: cfg({ maxLong: 5, resumeFront: false }), now: () => Date.parse('2026-11-20T17:00:00Z'), log: () => {} }).tick().movedFront, 0);
  assert.strictEqual(off[2].queued_at, '2026-11-19T12:00:00.000Z');
  assert.strictEqual(C.readConfig('/x', () => '{"resumeFront":false}').resumeFront, false);
});

test('held resuming video: released and moved to the front in the same tick', () => {
  const jobs = [job('r1', 'running', 20000), job('r2', 'running', 20000), at(job('f1', 'queued', 1500), '2026-11-19T11:00:00.000Z'),
    at(saved(job('back', 'queued', 21000, '2026-11-20T17:10:00.987Z')), '2026-11-20T14:03:25.833Z')];
  const s = C.createLongVideoCap({ db: fakeDb(jobs), read: cfg({ maxLong: 2 }), now: () => Date.parse('2026-11-20T17:06:30Z'), log: () => {} }).tick();
  assert.strictEqual(jobs[3].available_at, null);
  assert.deepStrictEqual(order(jobs), ['back', 'f1']);
  assert.strictEqual(s.released, 1); assert.strictEqual(s.movedFront, 1);
});
