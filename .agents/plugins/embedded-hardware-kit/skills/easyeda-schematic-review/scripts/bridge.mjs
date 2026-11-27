import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT_START = 49620;
const PORT_END = 49629;

async function fetchJson(url, options = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function findBridge(portHint) {
  const ports = portHint ? [Number(portHint)] : Array.from({ length: PORT_END - PORT_START + 1 }, (_, i) => PORT_START + i);
  for (const port of ports) {
    try {
      const health = await fetchJson(`http://127.0.0.1:${port}/health`, {}, 900);
      if (health?.service === 'easyeda-bridge') {
        return { port, url: `http://127.0.0.1:${port}`, health };
      }
    } catch { /* try next */ }
  }
  return null;
}

export async function listWindows(bridgeUrl) {
  return fetchJson(`${bridgeUrl}/eda-windows`);
}

export async function selectWindow(bridgeUrl, windowId) {
  return fetchJson(`${bridgeUrl}/eda-windows/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId }),
  });
}

export async function execute(bridgeUrl, code, { windowId, timeoutMs = 120000 } = {}) {
  const body = { code };
  if (windowId) body.windowId = windowId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${bridgeUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (json?.success === false || json?.error) {
      throw new Error(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));
    }
    return json?.result !== undefined ? json.result : json;
  } finally {
    clearTimeout(timer);
  }
}

/** Start the easyeda-api-skill bridge. Caller must have explicit user consent. */
export async function launchBridge(skillDir) {
  const candidates = [
    path.join(skillDir, '..', 'easyeda-api-skill', 'scripts', 'bridge-server.mjs'),
    path.join(skillDir, '..', '..', 'easyeda-api-skill', 'scripts', 'bridge-server.mjs'),
    path.join(os.homedir(), '.claude', 'skills', 'easyeda-api-skill', 'scripts', 'bridge-server.mjs'),
  ];
  const server = candidates.find(p => fs.existsSync(p));
  if (!server) throw new Error('找不到 easyeda-api-skill/scripts/bridge-server.mjs，无法自动启动 Bridge');
  const child = spawn(process.execPath, [server], {
    cwd: path.dirname(server),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    const found = await findBridge();
    if (found) return found;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Bridge 启动超时；请按 easyeda-api-skill 文档手动启动');
}

export function bridgeUnavailableMessage() {
  return [
    '未发现 EasyEDA Bridge。',
    '请先启动 easyeda-api-skill 的 Bridge：',
    '  node <easyeda-api-skill>/scripts/bridge-server.mjs',
    '并在 EasyEDA 中加载 run-api-gateway.eext。',
    '如需本 skill 代为启动，请明确同意后加 --start-bridge。',
  ].join('\n');
}

export async function resolveWindow(bridgeUrl, windowId) {
  const data = await listWindows(bridgeUrl);
  const windows = data?.windows || [];
  if (!windows.length) throw new Error('Bridge 已连接，但没有 EDA 窗口；请在 EasyEDA 中打开工程。');
  if (windowId) {
    const found = windows.find(w => w.windowId === windowId);
    if (!found) throw new Error(`EDA 窗口不存在: ${windowId}`);
    return windowId;
  }
  if (windows.length > 1) {
    throw new Error(`检测到 ${windows.length} 个 EDA 窗口，请用 --window-id 指定其中一个：` +
      windows.map(w => `${w.windowId}${w.active ? ' (active)' : ''}`).join(', '));
  }
  return windows[0].windowId;
}
