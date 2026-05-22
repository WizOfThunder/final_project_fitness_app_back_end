const {randomUUID} = require('crypto');

const DISPATCH_INTERVAL_MS = 60 * 1000;
const COMPLETED_JOB_TTL_MS = 30 * 60 * 1000;

const jobs = new Map();
const queuedJobIds = [];
const activeJobKeys = new Map();

let activeJobId = null;
let lastDispatchAt = 0;
let dispatchTimer = null;

function getJobKey(userId, planType) {
  return `${userId}:${planType}`;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function getPeopleAhead(job) {
  if (!job || job.status !== 'queued') {
    return 0;
  }

  const queueIndex = queuedJobIds.indexOf(job.id);
  if (queueIndex === -1) {
    return 0;
  }

  return queueIndex + (activeJobId && activeJobId !== job.id ? 1 : 0);
}

function serializeJob(job) {
  return {
    jobId: job.id,
    planType: job.planType,
    status: job.status,
    peopleAhead: getPeopleAhead(job),
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    failedAt: job.failedAt || null,
    planId: job.result?.plan?.id || null,
    error: job.error || null,
  };
}

function scheduleCleanup(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
  }, COMPLETED_JOB_TTL_MS);
}

function scheduleNextDispatch() {
  if (dispatchTimer) {
    clearTimeout(dispatchTimer);
    dispatchTimer = null;
  }

  if (activeJobId || queuedJobIds.length === 0) {
    return;
  }

  const nextAllowedAt = lastDispatchAt + DISPATCH_INTERVAL_MS;
  const delay = Math.max(0, nextAllowedAt - Date.now());

  dispatchTimer = setTimeout(() => {
    dispatchTimer = null;
    startNextJob();
  }, delay);
}

function completeJob(job, updates) {
  Object.assign(job, updates);
  activeJobId = null;
  activeJobKeys.delete(getJobKey(job.userId, job.planType));
  scheduleCleanup(job.id);
  scheduleNextDispatch();
}

function startNextJob() {
  if (activeJobId || queuedJobIds.length === 0) {
    scheduleNextDispatch();
    return;
  }

  const nextAllowedAt = lastDispatchAt + DISPATCH_INTERVAL_MS;
  if (Date.now() < nextAllowedAt) {
    scheduleNextDispatch();
    return;
  }

  const jobId = queuedJobIds.shift();
  const job = jobId ? jobs.get(jobId) : null;

  if (!job) {
    scheduleNextDispatch();
    return;
  }

  activeJobId = job.id;
  lastDispatchAt = Date.now();
  job.status = 'processing';
  job.startedAt = lastDispatchAt;

  Promise.resolve()
    .then(() => job.run(job.payload))
    .then(result => {
      completeJob(job, {
        status: 'completed',
        result,
        completedAt: Date.now(),
      });
    })
    .catch(error => {
      completeJob(job, {
        status: 'failed',
        error: error?.message || 'AI generation failed.',
        failedAt: Date.now(),
      });
    });
}

function enqueueJob({userId, planType, payload, run}) {
  const jobKey = getJobKey(userId, planType);
  const existingJobId = activeJobKeys.get(jobKey);
  const existingJob = existingJobId ? jobs.get(existingJobId) : null;

  if (existingJob && ['queued', 'processing'].includes(existingJob.status)) {
    return {
      job: existingJob,
      alreadyQueued: true,
    };
  }

  const job = {
    id: randomUUID(),
    userId,
    planType,
    payload,
    run,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    result: null,
    error: null,
  };

  jobs.set(job.id, job);
  queuedJobIds.push(job.id);
  activeJobKeys.set(jobKey, job.id);
  scheduleNextDispatch();

  return {
    job,
    alreadyQueued: false,
  };
}

module.exports = {
  enqueueJob,
  getJob,
  serializeJob,
};
