'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { timingPolicy, updateEwma } = require('./adaptive-timing');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpSchedulerClient {
  constructor(baseUrl, options = {}) {
    if (!baseUrl) throw new Error('scheduler base URL is required');
    this.baseUrl = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '::1'].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== 'https:' && !local && !options.allowInsecure) {
      throw new Error('remote scheduler URL must use HTTPS');
    }
    const tokenFile = options.tokenFile || process.env.SCHEDULER_API_TOKEN_FILE;
    this.token = options.token || process.env.SCHEDULER_API_TOKEN
      || (tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : null);
    if (!this.token) throw new Error('SCHEDULER_API_TOKEN or SCHEDULER_API_TOKEN_FILE is required');
    this.apiMeanMs = 300;
    this.apiSamples = 0;
  }

  async rpc(method, args) {
    const policy = timingPolicy('scheduler_api', this.apiMeanMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.requestTimeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(new URL('/v1/rpc', this.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method, args }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && payload.error ? payload.error : `scheduler HTTP ${response.status}`;
        const error = new Error(message);
        error.statusCode = response.status;
        throw error;
      }
      this.apiMeanMs = updateEwma(this.apiMeanMs, this.apiSamples, Date.now() - started);
      this.apiSamples++;
      return payload.result;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`scheduler API timed out after ${policy.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  registerWorker(...args) { return this.rpc('registerWorker', args); }
  recordProbe(...args) { return this.rpc('recordProbe', args); }
  isProbeFresh(...args) { return this.rpc('isProbeFresh', args); }
  acquireBudget(...args) { return this.rpc('acquireBudget', args); }
  recordRequestOutcome(...args) { return this.rpc('recordRequestOutcome', args); }
  recordOperationLatency(...args) { return this.rpc('recordOperationLatency', args); }
  getTimingPolicy(...args) { return this.rpc('getTimingPolicy', args); }
  teamProductionNormal(...args) { return this.rpc('teamProductionNormal', args); }
  claimTask(...args) { return this.rpc('claimTask', args); }
  markTaskProgress(...args) { return this.rpc('markTaskProgress', args); }
  heartbeat(...args) { return this.rpc('heartbeat', args); }
  queueState(...args) { return this.rpc('queueState', args); }
  workflowStatus(...args) { return this.rpc('workflowStatus', args); }
  markWorkflowComplete(...args) { return this.rpc('markWorkflowComplete', args); }
  reapExpiredLeases(...args) { return this.rpc('reapExpiredLeases', args); }
  commitOutcome(...args) { return this.rpc('commitOutcome', args); }
  progress(...args) { return this.rpc('progress', args); }

  async waitForBudget(workflowId, endpoint, cost = 1, signal = null) {
    const policy = await this.getTimingPolicy(workflowId, endpoint);
    while (true) {
      if (signal && signal.aborted) throw new Error('budget wait aborted');
      const result = await this.acquireBudget(workflowId, endpoint, cost);
      if (result.granted) return policy;
      await sleep(Math.min(policy.idlePollMs, result.waitMs + Math.floor(Math.random() * 50)));
    }
  }

  async downloadExport(workflowId, dataset, outputFile) {
    if (!['places.ndjson', 'place_boundaries.ndjson'].includes(dataset)) {
      throw new Error(`unsupported export dataset: ${dataset}`);
    }
    const policy = timingPolicy('scheduler_api', this.apiMeanMs);
    const controller = new AbortController();
    let timer;
    const resetTimeout = (delayMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), delayMs);
    };
    resetTimeout(policy.requestTimeoutMs);
    const url = new URL(
      `/v1/workflows/${encodeURIComponent(workflowId)}/export/${dataset}`,
      this.baseUrl,
    );
    const temp = `${outputFile}.tmp`;
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const output = fs.createWriteStream(temp);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let rows = 0;
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload && payload.error ? payload.error : `scheduler export HTTP ${response.status}`);
      }
      resetTimeout(policy.progressTimeoutMs);
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        resetTimeout(policy.progressTimeoutMs);
        hash.update(chunk);
        bytes += chunk.length;
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) rows++;
        if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      }
      await new Promise((resolve, reject) => {
        output.once('error', reject);
        output.end(resolve);
      });
      fs.renameSync(temp, outputFile);
      return { rows, bytes, sha256: hash.digest('hex') };
    } catch (error) {
      output.destroy();
      try { fs.unlinkSync(temp); } catch (_) {}
      if (error && error.name === 'AbortError') {
        throw new Error(`scheduler export made no progress within ${policy.progressTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async end() {}
}

module.exports = { HttpSchedulerClient };
