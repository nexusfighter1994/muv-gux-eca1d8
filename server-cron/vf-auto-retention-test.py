#!/usr/bin/env python3
"""Tests for vf-auto-retention.py in a temporary data folder. Usage: vf-auto-retention-test.py <script>"""
import importlib.util, os, sqlite3, sys, tempfile, time

tmp = tempfile.mkdtemp(prefix='vf-ar-test-')
os.environ['VF_DATA_DIR'] = tmp
os.environ['VF_AUTO_RETENTION_OFF'] = os.path.join(tmp, 'off')
spec = importlib.util.spec_from_file_location('ar', sys.argv[1]); ar = importlib.util.module_from_spec(spec); spec.loader.exec_module(ar)

NOW = time.time()
iso = lambda hours_ago: time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(NOW - hours_ago * 3600))
db = sqlite3.connect(os.path.join(tmp, 'vidforge.db'))
db.execute('create table queue_jobs (id text, status text, completed_at text)')
db.execute('create table pipeline_jobs (job_id text, stage text, project_slug text)')
projects = os.path.join(tmp, 'projects'); os.mkdir(projects)
outside = os.path.join(tmp, 'outside'); os.makedirs(os.path.join(outside, 'keep')); open(os.path.join(outside, 'keep', 'x'), 'w').write('x')


def video(job, slug, status='completed', stage='completed', hours=3.0, final_mb=60, dirs=('chunks', 'source', 'bin/final', 'bin/tts'), link=None):
    db.execute('insert into queue_jobs values (?,?,?)', (job, status, iso(hours) if hours is not None else None))
    db.execute('insert into pipeline_jobs values (?,?,?)', (job, stage, slug))
    root = os.path.join(projects, slug.replace('/', '_').replace('.', '_'))
    os.makedirs(root, exist_ok=True)
    for d in dirs:
        os.makedirs(os.path.join(root, d, 'deep'), exist_ok=True)
        open(os.path.join(root, d, 'deep', 'f.bin'), 'wb').write(b'0' * 1000)
    if link:
        os.symlink(outside, os.path.join(root, link))
    if final_mb:
        with open(os.path.join(root, 'final.mp4'), 'wb') as f:
            f.truncate(final_mb * 2**20)
    return root


roots = {
    'old_ok': video('aaaaaaaa-1', 'old-ok', hours=3),
    'young': video('bbbbbbbb-1', 'young', hours=1),
    'no_final': video('cccccccc-1', 'no-final', final_mb=0),
    'small_final': video('dddddddd-1', 'small-final', final_mb=10),
    'running': video('eeeeeeee-1', 'running', status='running', stage='chunkRender'),
    'stage_open': video('ffffffff-1', 'stage-open', stage='finalAssembly'),
    'too_old': video('11111111-1', 'too-old', hours=100),
    'link': video('22222222-1', 'link-case', dirs=('source',), link='chunks'),
    'partial': video('33333333-1', 'partial', dirs=('bin/job-assets',)),
    'tts_only': video('55555555-1', 'tts-only', dirs=('bin/tts',)),
}
db.execute('insert into queue_jobs values (?,?,?)', ('44444444-1', 'completed', iso(3)))
db.execute('insert into pipeline_jobs values (?,?,?)', ('44444444-1', 'completed', '../outside'))
db.commit(); db.close()
exists = lambda key, sub: os.path.isdir(os.path.join(roots[key], sub))
bad = 0


def check(name, cond):
    global bad
    print('ok  ' if cond else 'FAIL', name); bad += not cond


lines = []
open(os.environ['VF_AUTO_RETENTION_OFF'], 'w').close()
ar.run(now=NOW, out=lines.append)
check('off switch: nothing removed', exists('old_ok', 'chunks') and any('off switch' in l for l in lines))
os.remove(os.environ['VF_AUTO_RETENTION_OFF'])

lines = []
ar.run(dry=True, now=NOW, out=lines.append)
check('dry run: nothing removed, old video listed', exists('old_ok', 'chunks') and any('aaaaaaaa' in l and 'would free' in l for l in lines))
check('dry run: video without final reported as skipped', any('cccccccc' in l and 'skipped' in l for l in lines))

lines = []
ar.run(now=NOW, out=lines.append)
check('old finished video: chunks, source, bin/final removed', not any(exists('old_ok', s) for s in ('chunks', 'source', 'bin/final')))
check('old finished video: bin/tts kept (the app keeps it too)', exists('old_ok', 'bin/tts'))
check('old finished video: final kept', os.path.getsize(os.path.join(roots['old_ok'], 'final.mp4')) == 60 * 2**20)
check('finished 1 h ago: kept', exists('young', 'chunks'))
check('no final video: kept, silent in the real run', exists('no_final', 'chunks') and not any('cccccccc' in l for l in lines))
check('final under 50 MB: kept', exists('small_final', 'chunks'))
check('running video: kept', exists('running', 'chunks'))
check('pipeline stage not completed: kept', exists('stage_open', 'chunks'))
check('finished 100 h ago: not touched', exists('too_old', 'chunks'))
check('symlinked chunks: link and its target untouched, real source removed',
      os.path.islink(os.path.join(roots['link'], 'chunks')) and os.path.isfile(os.path.join(outside, 'keep', 'x')) and not exists('link', 'source'))
check('only existing subfolders removed', not exists('partial', 'bin/job-assets') and exists('partial', 'bin'))
check('video with only bin/tts left (app already swept): untouched, silent', exists('tts_only', 'bin/tts') and not any('55555555' in l for l in lines))
check('unsafe project name: outside folder untouched', os.path.isfile(os.path.join(outside, 'keep', 'x')))
check('done line written', any('done:' in l for l in lines))

lines = []
ar.run(now=NOW, out=lines.append)
check('second run: nothing left to do, no output', lines == [])
sys.exit(1 if bad else 0)
