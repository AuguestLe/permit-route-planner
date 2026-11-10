import { fork, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { AppError } from './errors.js';

export const OCR_INFO = Object.freeze({ engine: 'Tesseract', languages: Object.freeze(['chi_sim', 'eng']) });
const PREPARE_STAGES = new Set(['预处理图片', '读取本地模型']);
const ERRORS = {
  INVALID_OCR_PATH: [400, '只支持本地图片文件的绝对路径。'],
  OCR_FILE_MISSING: [404, '待识别图片不存在或无法读取，请重新上传。'],
  INVALID_IMAGE: [400, '图片无法解码，请重新上传完整的静态图片。'],
  OCR_MODEL_MISSING: [503, '本地中英文识别模型缺失或无法读取，请检查语言模型安装及 TESSDATA_PREFIX。'],
  OCR_ENGINE_MISSING: [503, '原生 Tesseract 未安装或无法执行，请安装 Tesseract，或设置 TESSERACT_BIN。'],
  OCR_TIMEOUT: [504, '图片识别超时，请使用更清晰或更小的图片重试。'],
  ABORTED: [499, '图片识别已取消。'],
  OCR_FAILED: [500, '本地文字识别失败，请稍后重试。'],
  NO_TEXT: [422, '未识别到文字，请上传清晰、完整的证件图片。'],
};
const PREPARE_ERRORS = new Set(['INVALID_OCR_PATH', 'OCR_FILE_MISSING', 'INVALID_IMAGE', 'OCR_MODEL_MISSING']);
const MAX_TEXT_LENGTH = 200_000;

function appError(code) {
  const [status, message] = ERRORS[code];
  return new AppError(status, code, message);
}

function localPath(value) {
  return typeof value === 'string' && isAbsolute(value) && !value.startsWith('//') && !value.includes('\0');
}

// 预处理与原生引擎依次作为直接子进程运行，取消时不遗留孙进程。
export function createRecognizer({
  timeoutMs = 120_000,
  tesseractPath = process.env.TESSERACT_BIN || 'tesseract',
  tessdataDir = process.env.TESSDATA_PREFIX || undefined,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new AppError(400, 'INVALID_OCR_TIMEOUT', '识别超时设置无效。');
  }
  if (typeof tesseractPath !== 'string' || !tesseractPath.trim() || tesseractPath.includes('\0')
    || (tessdataDir !== undefined && !localPath(tessdataDir))) {
    throw new AppError(400, 'INVALID_OCR_CONFIG', 'Tesseract 配置无效，模型目录必须为本地绝对路径。');
  }
  return async function recognize(filePath, imageId, onStage = () => {}, signal) {
    if (signal?.aborted) throw appError('ABORTED');
    if (!localPath(filePath)) throw appError('INVALID_OCR_PATH');
    // imageId 仅由调用方用于证据映射，不发送给引擎或日志。
    return new Promise((resolve, reject) => {
      let child;
      let prepared;
      let failure;
      let finished = false;
      let terminalReceived = false;
      let text = '';
      let stderr = '';

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (!text.trim()) reject(appError('NO_TEXT'));
        // txt 输出没有置信度，明确保留 null，不用猜测值替代。
        else resolve({ text, confidence: null, ...OCR_INFO });
      };
      const stop = (error) => {
        if (finished || failure) return;
        failure = error;
        if (child?.pid) child.kill('SIGKILL');
        else finish();
      };
      const onAbort = () => stop(appError('ABORTED'));
      const stage = (label) => {
        if (finished || failure) return;
        try {
          Promise.resolve(onStage(label)).catch(() => stop(appError('OCR_FAILED')));
        } catch {
          stop(appError('OCR_FAILED'));
        }
      };
      const timer = setTimeout(() => stop(appError('OCR_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();

      const startEngine = () => {
        stage('加载识别引擎');
        if (finished || failure) return;
        try {
          // 图片只经 stdin 输入；不经过 shell，不把用户文件名当作命令参数。
          const engine = spawn(tesseractPath, [
            'stdin', 'stdout', '--tessdata-dir', prepared.modelDirectory,
            '-l', OCR_INFO.languages.join('+'), '--oem', '1', '--psm', '3',
            '-c', 'tessedit_create_txt=1',
          ], {
            shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, OMP_THREAD_LIMIT: '1' },
          });
          child = engine;
          engine.stdout.setEncoding('utf8');
          engine.stderr.setEncoding('utf8');
          engine.stdout.on('data', (chunk) => {
            if (failure) return;
            if (text.length + chunk.length > MAX_TEXT_LENGTH) return stop(appError('OCR_FAILED'));
            text += chunk;
          });
          engine.stderr.on('data', (chunk) => {
            if (failure) return;
            if (stderr.length + chunk.length > 65_536) return stop(appError('OCR_FAILED'));
            stderr += chunk;
          });
          engine.stdin.on('error', (error) => {
            // 提前退出的引擎可能关闭 stdin；由 close 和 stderr 提供实际错误。
            if (error.code !== 'EPIPE') stop(appError('OCR_FAILED'));
          });
          engine.once('error', (error) => stop(appError(
            ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code) ? 'OCR_ENGINE_MISSING' : 'OCR_FAILED',
          )));
          engine.once('close', (code) => {
            child = null;
            // Tesseract 可能在中文模型损坏时仅用英文继续并返回 0，禁止这种静默降级。
            if (!failure && /Failed loading language|Error opening data file|Could not initialize tesseract/i.test(stderr)) {
              failure = appError('OCR_MODEL_MISSING');
            }
            if (!failure && code !== 0) failure = appError('OCR_FAILED');
            finish();
          });
          engine.once('spawn', () => {
            stage('识别文字');
            if (!failure) engine.stdin.end(prepared.image);
            prepared = null;
          });
        } catch {
          stop(appError('OCR_FAILED'));
        }
      };

      try {
        const preparer = fork(new URL('./ocr-child.js', import.meta.url), [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], serialization: 'advanced',
        });
        child = preparer;
        preparer.once('close', (code) => {
          child = null;
          if (!failure && (code !== 0 || !prepared)) failure = appError('OCR_FAILED');
          if (failure) finish();
          else startEngine();
        });
        preparer.on('error', () => stop(appError('OCR_FAILED')));
        preparer.on('disconnect', () => {
          if (!terminalReceived) stop(appError('OCR_FAILED'));
        });
        preparer.on('message', (message) => {
          if (finished || failure || terminalReceived) return;
          if (message?.type === 'stage' && PREPARE_STAGES.has(message.stage)) {
            stage(message.stage);
          } else if (message?.type === 'prepared' && Buffer.isBuffer(message.image)
            && message.image.length > 0 && message.image.length <= 32 * 1024 ** 2 && localPath(message.modelDirectory)) {
            terminalReceived = true;
            prepared = message;
          } else if (message?.type === 'error') {
            terminalReceived = true;
            stop(appError(PREPARE_ERRORS.has(message.code) ? message.code : 'OCR_FAILED'));
          } else {
            stop(appError('OCR_FAILED'));
          }
        });
        preparer.send({ filePath, tessdataDir }, (error) => { if (error) stop(appError('OCR_FAILED')); });
      } catch {
        stop(appError('OCR_FAILED'));
      }
    });
  };
}
