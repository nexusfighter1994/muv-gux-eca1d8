#!/usr/bin/env python3
"""Automatic cleanup of intermediates of finished videos (owner 2026-11-14 ~08:50 local: "1" = yes to
"delete intermediates automatically 2 h after completion, only if the final video exists (> 50 MB)").

The app itself removes them only 24 h after completion; with 8 parallel videos the disk fell 15-28 GB/h.
Every run (cron, every 15 min): videos with queue status 'completed', pipeline stage 'completed',
completed 2 h to 3 days ago, a safe project name and at least one MP4 > 50 MB on the project's top level
-> remove what the app's own sweep would remove 22 h later (chunks/, source/ and the swept bin subfolders;
bin/tts and thumbnail files stay). Never symlinks, never anything else. Each removal is logged with its
size before it happens.
Off switch: touch /opt/aufsetzen/claude-watch/vf-auto-retention.off
Usage: vf-auto-retention.py [--dry]"""
import os, re, shutil, sqlite3, subprocess, sys, time

DATA = os.environ.get('VF_DATA_DIR', '/var/lib/docker/volumes/aufsetzen-apps_vidforge-data/_data')
OFF = os.environ.get('VF_AUTO_RETENTION_OFF', '/opt/aufsetzen/claude-watch/vf-auto-retention.off')
MIN_AGE_H, MAX_AGE_H, FINAL_MIN_BYTES = 2, 72, 50 * 2**20
# Exactly what the app's own 24 h sweep removes (bundle: chunks/, source/, bin/translation-source and the
# bin subfolders FGa), only earlier. bin/tts and the thumbnail work files stay, as the app keeps them.
SUBDIRS = ('chunks', 'source', 'bin/final', 'bin/cta', 'bin/avatar', 'bin/transcript', 'bin/source-transcript',
           'bin/job-assets', 'bin/translation-source')


def iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(t))


def size_gb(path):
    try:
        out = subprocess.run(['du', '-s', '--block-size=1M', path], capture_output=True, text=True, timeout=600).stdout.split()
        return int(out[0]) / 1024 if out else 0.0
    except (subprocess.SubprocessError, ValueError):
        return 0.0


def candidates(db, now):
    return db.execute(
        "select q.id, q.completed_at, p.project_slug from queue_jobs q join pipeline_jobs p on p.job_id = q.id "
        "where q.status = 'completed' and p.stage = 'completed' and q.completed_at is not null "
        "and q.completed_at <= ? and q.completed_at >= ? order by q.completed_at",
        (iso(now - MIN_AGE_H * 3600), iso(now - MAX_AGE_H * 3600))).fetchall()


def run(dry=False, now=None, out=print):
    now = time.time() if now is None else now
    stamp = iso(now) + 'Z'
    if os.path.exists(OFF):
        out(f'{stamp} off switch present, nothing done')
        return 0.0
    projects = os.path.realpath(os.path.join(DATA, 'projects'))
    db = sqlite3.connect(f'file:{DATA}/vidforge.db?mode=ro', uri=True)
    try:
        rows = candidates(db, now)
    finally:
        db.close()
    freed, cleaned = 0.0, 0
    for job, completed, slug in rows:
        if not slug or not re.fullmatch(r'[a-zA-Z0-9_-]+', slug):
            continue
        root = os.path.realpath(os.path.join(projects, slug))
        if not root.startswith(projects + os.sep) or not os.path.isdir(root):
            continue
        present = [s for s in SUBDIRS if os.path.isdir(os.path.join(root, s)) and not os.path.islink(os.path.join(root, s))
                   and not os.path.islink(os.path.dirname(os.path.join(root, s)))
                   and os.path.realpath(os.path.join(root, s)).startswith(root + os.sep)]
        if not present:
            continue
        finals = [f for f in os.listdir(root) if f.endswith('.mp4') and os.path.isfile(os.path.join(root, f))
                  and not os.path.islink(os.path.join(root, f)) and os.path.getsize(os.path.join(root, f)) > FINAL_MIN_BYTES]
        if not finals:
            if dry:  # the cron run stays silent here, or it would log the same video every 15 min
                out(f'{stamp} {job[:8]} skipped: no final video > 50 MB on the top level')
            continue
        job_gb = 0.0
        for sub in present:
            path = os.path.join(root, sub)
            gb = size_gb(path)
            out(f'{stamp} {job[:8]} {sub} {gb:.2f} GB {"(dry)" if dry else "removing"}')
            if not dry:
                shutil.rmtree(path)
            job_gb += gb
        cleaned += 1
        freed += job_gb
        out(f'{stamp} {job[:8]} completed {completed[:16]} {"would free" if dry else "freed"} {job_gb:.1f} GB, final kept: {", ".join(finals)[:80]}')
    if cleaned:
        out(f'{stamp} done: {cleaned} video(s), {freed:.1f} GB {"would be freed (dry)" if dry else "freed"}')
    return freed


if __name__ == '__main__':
    run(dry='--dry' in sys.argv[1:])
