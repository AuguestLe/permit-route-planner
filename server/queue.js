import { join } from 'node:path';
import { extractPermitFields } from './fields.js';
import { check } from './errors.js';

const ERROR_MESSAGES = {
  OCR_TIMEOUT: '本地识别超时，请裁剪清晰图片后重新上传，或手动重试。',
  NO_TEXT: '未识别到文字，请上传清晰、正向的证件图片。',
  OCR_MODEL_MISSING: '本地中英文模型不可用，请检查项目语言模型依赖或 TESSDATA_PREFIX 指定的目录。',
  OCR_ENGINE_MISSING: '原生 Tesseract 未安装或无法执行，请安装 Tesseract，或设置 TESSERACT_BIN 后重启服务。',
  ABORTED: '识别已中止，可手动重试。',
  OCR_FAILED: '本地识别失败，请检查图片后手动重试。',
};

export class OcrQueue {
  constructor(store, imageRoot, recognize) {
    this.store = store;
    this.imageRoot = imageRoot;
    this.recognize = recognize;
    this.pending = [];
    this.current = null;
    this.running = false;
    this.closing = false;
    this.waiters = [];
  }

  add(taskId, imageIds, version) {
    check(!this.closing, 503, 'SERVICE_STOPPING', '服务正在停止，请稍后重试。');
    const task = this.store.get(taskId);
    const count = task.images.filter(i => imageIds.includes(i.id) && ['pending', 'failed'].includes(i.status)).length;
    check(this.pending.length + count <= 20, 429, 'QUEUE_FULL', '识别队列已满，请等待当前任务完成后重试。');
    this.pending.push(...this.store.enqueue(taskId, imageIds, version));
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
        if (!this.store.stage(job.taskId, job.imageId, job.token, '准备本地识别')) continue;
        try {
          const result = await this.recognize(join(this.imageRoot, job.taskId, job.filename), job.imageId, stage => {
            this.store.stage(job.taskId, job.imageId, job.token, stage);
          }, controller.signal);
          if (controller.signal.aborted) continue;
          const extracted = extractPermitFields(result.text, job.imageId);
          this.store.complete(job.taskId, job.imageId, job.token, { ...result, ...extracted });
        } catch (error) {
          const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'OCR_FAILED';
          this.store.fail(job.taskId, job.imageId, job.token, code, ERROR_MESSAGES[code]);
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

  cancel(taskId) {
    for (const job of this.pending.filter(job => job.taskId === taskId)) {
      this.store.fail(job.taskId, job.imageId, job.token, 'ABORTED', ERROR_MESSAGES.ABORTED);
    }
    this.pending = this.pending.filter(job => job.taskId !== taskId);
    if (this.current?.taskId === taskId) {
      const job = this.current;
      this.store.fail(job.taskId, job.imageId, job.token, 'ABORTED', ERROR_MESSAGES.ABORTED);
      job.controller.abort();
    }
  }

  whenIdle() {
    return this.running ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve();
  }

  async close() {
    this.closing = true;
    for (const job of this.pending) this.store.fail(job.taskId, job.imageId, job.token, 'INTERRUPTED', '服务已停止，请手动重试。');
    this.pending = [];
    if (this.current) {
      const job = this.current;
      this.store.fail(job.taskId, job.imageId, job.token, 'INTERRUPTED', '服务已停止，请手动重试。');
      job.controller.abort();
    }
    await this.whenIdle();
  }
}
