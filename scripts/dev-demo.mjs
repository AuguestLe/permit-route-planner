import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const processes = [
  spawn(process.execPath, ['server/demo/index.js'], { cwd: root, stdio: 'inherit', env: { ...process.env } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.js', '--mode', 'demo'], { cwd: root, stdio: 'inherit', env: { ...process.env } }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  processes.forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
}
processes.forEach(child => {
  child.on('error', () => { console.error('启动失败，请先安装项目依赖。'); stop(1); });
  child.on('exit', code => stop(code ?? 0));
});
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
