exports.createOptimizedEta=({wi,psr,rPs})=>(function nPs({ lane, target, ahead, row, profiles, limits }) {
  const size = wi(row?.size) || wi(limits[lane]) || 1;
  const concurrency = Math.max(1, Math.floor(row?.memoryBlocked ? Math.max(1, Number(row.activeForJob) || 0) : size));
  const fallback = rPs(profiles, lane, [...ahead, target]);
  const targetTasks = [...psr(target, lane)];
  const queued = Math.max(0, Math.ceil(Number(row?.queuedForJob) || 0));
  for (; targetTasks.length < queued;) targetTasks.push(fallback);
  if (!targetTasks.length) return target.remainingPreparationSeconds;
  const active = ahead.map((job, index) => ({ priority: index + 1, readyAt: job.remainingPreparationSeconds, tasks: [...psr(job, lane)], target: false, head: 0 })).filter(job => job.tasks.length);
  const knownAhead = active.reduce((sum, job) => sum + job.tasks.length, 0);
  const requiredAhead = Math.max(0, Math.ceil(Number(row?.demandAhead) || 0), Math.ceil(Number(row?.queuedAhead) || 0));
  if (requiredAhead > knownAhead) active.unshift({ priority: 0, readyAt: 0, tasks: Array(requiredAhead - knownAhead).fill(fallback), target: false, head: 0 });
  if (!active.length) {
    const work = targetTasks.reduce((sum, task) => sum + task, 0);
    return target.remainingPreparationSeconds + work / concurrency;
  }
  active.push({ priority: ahead.length + 1, readyAt: target.remainingPreparationSeconds, tasks: targetTasks, target: true, head: 0 });
  active.sort((a, b) => a.priority - b.priority);
  const slots = Array(concurrency).fill(0);
  let completion = target.remainingPreparationSeconds;
  while (active.length) {
    let slot = 0;
    for (let i = 1; i < slots.length; i++) if (slots[i] < slots[slot]) slot = i;
    let time = slots[slot];
    let index = active.findIndex(job => job.readyAt <= time);
    if (index < 0) {
      time = Infinity;
      for (const job of active) time = Math.min(time, job.readyAt);
      slots[slot] = time;
      index = active.findIndex(job => job.readyAt <= time);
    }
    const job = active[index];
    const finish = time + job.tasks[job.head++];
    slots[slot] = finish;
    if (job.target) completion = Math.max(completion, finish);
    // Remaining queue order is unchanged; completed jobs no longer need scans.
    if (job.head === job.tasks.length) active.splice(index, 1);
  }
  return completion;
});
