import { check } from '../errors.js';

const STAGE_LABELS = new Set(['质检', '本地识别', '多模态抽取', 'Schema 校验', '置信度分级']);

/** Serial in-process queue for one demo record at a time. */
export class DemoQueue {
  constructor({ store, onRun }) {
    if (typeof onRun !== 'function') throw new TypeError('onRun is required');
    this.store = store;
    this.onRun = onRun;
    this.pending = [];
    this.current = null;
    this.running = false;
    this.closing = false;
    this.waiters = [];
  }

  add({ recordId, version, mode = 'local-ocr', externalConfirmed = false }) {
    check(!this.closing, 503, 'SERVICE_STOPPING', '服务正在停止。');
    check(this.pending.length + 1 <= 20, 429, 'QUEUE_FULL', '核验队列已满，请稍后重试。');
    const job = this.store.enqueue(recordId, version, mode);
    this.pending.push({ ...job, externalConfirmed });
    void this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length && !this.closing) {
        const job = this.pending.shift();
        const controller = new AbortController();
        this.current = { ...job, controller };
        if (!this.store.stage(job.recordId, job.token, '质检')) continue;
        try {
          const result = await this.onRun(job, controller.signal, stage => {
            if (STAGE_LABELS.has(stage)) this.store.stage(job.recordId, job.token, stage);
          });
          if (controller.signal.aborted) continue;
          this.store.complete(job.recordId, job.token, result);
        } catch (error) {
          if (!controller.signal.aborted) this.store.fail(job.recordId, job.token, error);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.current = null;
      this.running = false;
      this.waiters.splice(0).forEach(resolve => resolve());
    }
  }

  cancel(recordId) {
    for (const job of this.pending.filter(item => item.recordId === recordId)) {
      this.store.fail(job.recordId, job.token, { code: 'ABORTED' });
    }
    this.pending = this.pending.filter(item => item.recordId !== recordId);
    if (this.current?.recordId === recordId) {
      const job = this.current;
      this.store.fail(job.recordId, job.token, { code: 'ABORTED' });
      job.controller.abort();
    }
  }

  whenIdle() {
    return this.running ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve();
  }

  async close() {
    this.closing = true;
    for (const job of this.pending) this.store.fail(job.recordId, job.token, { code: 'INTERRUPTED' });
    this.pending = [];
    if (this.current) {
      this.store.fail(this.current.recordId, this.current.token, { code: 'INTERRUPTED' });
      this.current.controller.abort();
    }
    await this.whenIdle();
  }
}
