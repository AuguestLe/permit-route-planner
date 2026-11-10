const VISION_VARIABLES = [
  'DEMO_VISION_BASE_URL',
  'DEMO_VISION_MODEL',
  'DEMO_VISION_API_KEY',
];

const TIMEOUT_DEFAULT_MS = 60000;
const TIMEOUT_MIN_MS = 1000;
const TIMEOUT_MAX_MS = 120000;

function read(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readTimeout(env) {
  const raw = read(env, 'DEMO_VISION_TIMEOUT_MS');
  if (!raw) return TIMEOUT_DEFAULT_MS;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    throw new Error(`DEMO_VISION_TIMEOUT_MS 必须是 ${TIMEOUT_MIN_MS}～${TIMEOUT_MAX_MS} 之间的整数。`);
  }
  return timeoutMs;
}

export function loadDemoConfig(env = {}) {
  const baseUrl = read(env, 'DEMO_VISION_BASE_URL');
  const model = read(env, 'DEMO_VISION_MODEL');
  const apiKey = read(env, 'DEMO_VISION_API_KEY');
  const timeoutMs = readTimeout(env);
  const present = [baseUrl, model, apiKey].filter(Boolean).length;

  if (present === 0) return Object.freeze({ vision: null, visionConfigured: false });
  if (present < VISION_VARIABLES.length) {
    const missing = VISION_VARIABLES.filter(name => !read(env, name));
    throw new Error(`Demo 视觉配置不完整，缺少：${missing.join('、')}。`);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('DEMO_VISION_BASE_URL 必须是有效的 HTTPS URL。');
  }
  if (url.protocol !== 'https:') throw new Error('DEMO_VISION_BASE_URL 必须使用 HTTPS 协议。');
  if (url.username || url.password) throw new Error('DEMO_VISION_BASE_URL 不得包含用户名或密码。');

  const vision = { baseUrl, model, apiKey, timeoutMs };
  Object.defineProperty(vision, 'toJSON', {
    value: () => ({ baseUrl, model, timeoutMs }),
    enumerable: false,
  });
  Object.freeze(vision);
  return Object.freeze({ vision, visionConfigured: true });
}
