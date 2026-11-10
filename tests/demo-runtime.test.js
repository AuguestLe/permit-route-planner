import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

const configModule = await import('../server/demo/config.js').catch(() => ({}));
const appModule = await import('../server/demo/app.js').catch(() => ({}));
const { loadDemoConfig } = configModule;
const { createDemoRuntime } = appModule;

const VISION_ENV = {
  DEMO_VISION_BASE_URL: 'https://api.example.com/v1',
  DEMO_VISION_MODEL: 'vision-model',
  DEMO_VISION_API_KEY: 'secret-test-value',
};

async function setup(t) {
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  assert.equal(typeof createDemoRuntime, 'function', 'demo runtime must be implemented');
  const root = await mkdtemp(join(tmpdir(), 'demo-runtime-'));
  const runtime = await createDemoRuntime({ dataDir: join(root, 'demo'), config: loadDemoConfig({}) });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, root };
}

test('demo health is local-only and synthetic-only', async t => {
  const { runtime } = await setup(t);
  const res = await request(runtime.app).get('/api/demo/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, localOnly: true, syntheticOnly: true, visionConfigured: false });
});

test('demo health keeps the same local and cache protections as the local API', async t => {
  const { runtime } = await setup(t);
  const ok = await request(runtime.app).get('/api/demo/health');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['x-frame-options'], 'DENY');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal((await request(runtime.app).get('/api/demo/health').set('Sec-Fetch-Site', 'cross-site')).status, 403);
  assert.equal((await request(runtime.app).get('/api/demo/health').set('Host', 'evil.example.com')).status, 403);
  assert.equal((await request(runtime.app).get('/api/demo/health').set('Origin', 'http://evil.example.com')).status, 403);
});

test('vision config requires https and never serializes the key', () => {
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  const config = loadDemoConfig(VISION_ENV);
  assert.equal(config.visionConfigured, true);
  assert.equal(config.vision.apiKey, 'secret-test-value');
  assert.equal(config.vision.baseUrl, 'https://api.example.com/v1');
  assert.equal(config.vision.model, 'vision-model');
  assert.equal(config.vision.timeoutMs, 60000);
  assert.doesNotMatch(JSON.stringify({ configured: config.visionConfigured }), /secret-test-value/);
  assert.doesNotMatch(JSON.stringify(config), /secret-test-value/);
  assert.throws(() => loadDemoConfig({
    DEMO_VISION_BASE_URL: 'http://api.example.com/v1',
    DEMO_VISION_MODEL: 'm',
    DEMO_VISION_API_KEY: 'k',
  }), /HTTPS/);
});

test('vision config is null only when all three vision fields are absent', () => {
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  assert.deepEqual(loadDemoConfig({}), { vision: null, visionConfigured: false });
  assert.deepEqual(loadDemoConfig({ DEMO_VISION_TIMEOUT_MS: '' }), { vision: null, visionConfigured: false });
  for (const env of [
    { DEMO_VISION_BASE_URL: 'https://api.example.com/v1', DEMO_VISION_MODEL: 'vision-model' },
    { DEMO_VISION_BASE_URL: 'https://api.example.com/v1', DEMO_VISION_API_KEY: 'secret' },
    { DEMO_VISION_MODEL: 'vision-model', DEMO_VISION_API_KEY: 'secret' },
  ]) {
    assert.throws(() => loadDemoConfig(env), /缺少|不完整|DEMO_VISION_/);
  }
});

test('vision timeout defaults to 60000 and stays within 1000..120000', () => {
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  assert.equal(loadDemoConfig({ ...VISION_ENV, DEMO_VISION_TIMEOUT_MS: '45000' }).vision.timeoutMs, 45000);
  for (const value of ['999', '120001', '1.5', 'soon']) {
    assert.throws(() => loadDemoConfig({ ...VISION_ENV, DEMO_VISION_TIMEOUT_MS: value }), /1000.*120000|120000.*1000/);
  }
});

test('vision base URL rejects userinfo and malformed values', () => {
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  assert.throws(() => loadDemoConfig({
    ...VISION_ENV,
    DEMO_VISION_BASE_URL: 'https://user:pass@api.example.com/v1',
  }), /用户名|密码|userinfo|凭据/i);
  assert.throws(() => loadDemoConfig({ ...VISION_ENV, DEMO_VISION_BASE_URL: 'not-a-url' }), /URL/);
});

test('demo runtime creates a private isolated data directory and leaves legacy data untouched', async t => {
  assert.equal(typeof createDemoRuntime, 'function', 'demo runtime must be implemented');
  assert.equal(typeof loadDemoConfig, 'function', 'demo config must be implemented');
  const root = await mkdtemp(join(tmpdir(), 'demo-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.data'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, '.test-artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.data', 'keep.txt'), 'legacy');
  await writeFile(join(root, '.test-artifacts', 'keep.txt'), 'legacy');
  const runtime = await createDemoRuntime({ dataDir: join(root, 'demo'), config: loadDemoConfig({}) });
  t.after(() => runtime.close());
  assert.equal((await stat(join(root, 'demo'))).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(root)).sort(), ['.data', '.test-artifacts', 'demo']);
  assert.equal(await readFile(join(root, '.data', 'keep.txt'), 'utf8'), 'legacy');
  assert.equal(await readFile(join(root, '.test-artifacts', 'keep.txt'), 'utf8'), 'legacy');
});

test('demo runtime sources never reference legacy data or the original server entry', async () => {
  const base = new URL('../server/demo/', import.meta.url);
  for (const name of ['config.js', 'app.js', 'index.js']) {
    const source = await readFile(fileURLToPath(new URL(name, base)), 'utf8');
    assert.doesNotMatch(source, /server\/index\.js|\.test-artifacts/);
    assert.doesNotMatch(source, /(?<![-\w])\.data(?![-\w])/);
    assert.doesNotMatch(source, /from ['"](?:\.\.\/)+index\.js['"]/);
  }
});
