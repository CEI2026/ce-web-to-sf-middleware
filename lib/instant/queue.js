'use strict';
// ce-web-to-sf-middleware - lib/instant/queue.js
// JobQueue: work waiting for Freddie. Freddie long-polls claim(); a job claimed
// but not finished within claimTimeoutMs goes back in the queue (Freddie crashed).
// SubmissionStore: what the browser asks about (result, report), kept in memory.
// Salesforce is the durable record; this memory is lost on a restart, and
// lib/instant/recover.js rebuilds unfinished work from Salesforce.
const crypto = require('crypto');

class JobQueue {
  constructor({ claimTimeoutMs = 120000, now = () => Date.now() } = {}) {
    this.claimTimeoutMs = claimTimeoutMs;
    this.now = now;
    this.jobs = new Map();      // job_id -> job
    this.ready = [];            // job_ids waiting to be claimed (FIFO)
    this.waiters = [];          // pollers waiting for work
    this.lastPollAt = null;
  }

  enqueue(submissionId, payload) {
    const job = {
      job_id: crypto.randomUUID(), submission_id: submissionId,
      received_utc: new Date(this.now()).toISOString(), payload,
      state: 'queued', claimedAt: null,
    };
    this.jobs.set(job.job_id, job);
    this.ready.push(job.job_id);
    this._dispatch();
    return job;
  }

  _public(job) {
    return { job_id: job.job_id, submission_id: job.submission_id, received_utc: job.received_utc, payload: job.payload };
  }

  _requeueExpired() {
    const t = this.now();
    for (const job of this.jobs.values()) {
      if (job.state === 'claimed' && t - job.claimedAt > this.claimTimeoutMs) {
        job.state = 'queued'; job.claimedAt = null;
        this.ready.unshift(job.job_id);
      }
    }
  }

  _dispatch() {
    this._requeueExpired();
    while (this.ready.length && this.waiters.length) {
      const id = this.ready.shift();
      const job = this.jobs.get(id);
      if (!job || job.state !== 'queued') continue;
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      job.state = 'claimed'; job.claimedAt = this.now();
      w.resolve(this._public(job));
    }
  }

  // Resolves with a job, or null after waitMs with nothing to do.
  claim(waitMs) {
    this.lastPollAt = this.now();
    this._requeueExpired();
    return new Promise(resolve => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, Math.max(0, waitMs));
      this.waiters.push(w);
      this._dispatch();
    });
  }

  // Freddie reported a failure for this job: put it back at the front of the queue.
  release(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.state = 'queued'; job.claimedAt = null;
    this.ready.unshift(jobId);
    this._dispatch();
    return true;
  }

  get(jobId) { return this.jobs.get(jobId) || null; }
  complete(jobId) { return this.jobs.delete(jobId); }
  hasSubmission(submissionId) {
    for (const j of this.jobs.values()) if (j.submission_id === submissionId) return true;
    return false;
  }
  stats() {
    let queued = 0; let claimed = 0;
    for (const j of this.jobs.values()) { if (j.state === 'queued') queued++; else claimed++; }
    return { queued, claimed, waitingPollers: this.waiters.length, lastPollAt: this.lastPollAt };
  }
  close() { for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(null); } this.waiters = []; }
}

class SubmissionStore {
  constructor({ now = () => Date.now(), ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.map = new Map();
  }
  get(id) { return this.map.get(id) || null; }
  create(id, { payload, jobId = null }) {
    const rec = {
      submission_id: id, building_id: payload.building.building_id, payload,
      createdAt: this.now(), status: 'pending', result: null, resultAt: null,
      report: { state: 'preparing', filename: null, pdf: null }, jobId, waiters: [],
    };
    this.map.set(id, rec);
    return rec;
  }
  byJob(jobId) { for (const r of this.map.values()) if (r.jobId === jobId) return r; return null; }
  setResult(id, result) {
    const rec = this.map.get(id); if (!rec) return null;
    rec.result = result; rec.status = 'complete'; rec.resultAt = this.now();
    for (const w of rec.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(rec); }
    return rec;
  }
  setReport(id, { filename, pdf }) {
    const rec = this.map.get(id); if (!rec) return null;
    rec.report = { state: 'ready', filename, pdf };
    return rec;
  }
  // Resolves with the record once it has a result, or null after ms.
  waitComplete(id, ms) {
    const rec = this.map.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.status === 'complete') return Promise.resolve(rec);
    return new Promise(resolve => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        const i = rec.waiters.indexOf(w); if (i >= 0) rec.waiters.splice(i, 1);
        resolve(null);
      }, Math.max(0, ms));
      rec.waiters.push(w);
    });
  }
  purge() {
    const cut = this.now() - this.ttlMs;
    for (const [id, r] of this.map) if (r.createdAt < cut) this.map.delete(id);
  }
}

module.exports = { JobQueue, SubmissionStore };
