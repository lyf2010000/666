import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * EasyEDA Pro / JLCEDA Pro built-in CLI transport (v4.1.70+).
 *
 * Both the mainland (`lceda-pro`) and international (`easyeda-pro`) desktop
 * editions expose the same CLI: `open --path <project.eprj3>` creates a
 * session, `invoke --session <id> --ext-uuid eda --code <async fn body>` runs
 * code with the editor's built-in extension identity, and `session close
 * --destroy` tears it down. Project data is ALWAYS read through the editor
 * APIs (`eda.dmt_*` / `eda.sch_*` / `eda.sys_*`) — this module never parses
 * or writes the `.eprj3` file format itself.
 *
 * The installed client is the source of truth for command names and options;
 * every call goes through the common JSON envelope `{ok, value, logs}`.
 */

export const CLI_MIN_VERSION = [4, 1, 70];
export const CLI_EDITIONS = ['lceda-pro', 'easyeda-pro'];

export function parseCliVersion(text) {
  const m = String(text || '').match(/\b(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Well-known install locations (PATH probing happens first). */
export function defaultCliCandidates() {
  const out = [];
  if (process.platform === 'win32') {
    for (const name of CLI_EDITIONS) {
      out.push(`C:/Program Files/${name}/${name}.exe`);
      if (process.env.LOCALAPPDATA) out.push(`${process.env.LOCALAPPDATA}/Programs/${name}/${name}.exe`);
    }
  } else if (process.platform === 'darwin') {
    for (const name of CLI_EDITIONS) out.push(`/Applications/${name}.app/Contents/MacOS/${name}`);
  }
  return out.map(p => p.replace(/\\/g, '/'));
}

/**
 * Run the CLI and unwrap the JSON envelope. Throws on non-JSON output or
 * `ok:false`; returns `value` on success (for `invoke` that is the JS return
 * value, so callers must still inspect its contents).
 */
export function runCliJson(executable, args, { spawnFn = spawnSync, timeoutMs = 120000 } = {}) {
  const res = spawnFn(executable, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res?.error) throw new Error(`CLI 调用失败（${executable} ${args[0] || ''}）: ${res.error.message}`);
  const stdout = String(res?.stdout || '').trim();
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    const stderr = String(res?.stderr || '').trim().slice(0, 300);
    throw new Error(`CLI 输出不是 JSON（${executable} ${args[0] || ''}）: ${stderr || stdout.slice(0, 300) || '空输出'}`);
  }
  if (json?.ok === false) {
    const err = new Error(json.error?.message || JSON.stringify(json.error || json));
    err.code = json.error?.code || 'CLI_ERROR';
    throw err;
  }
  return json?.value;
}

/**
 * Locate a usable CLI. Order: explicit path → SCHEMATIC_REVIEW_CLI →
 * PATH names (both editions) → well-known install dirs. Returns
 * `{executable, command, version}` or null when nothing works.
 * An explicitly given path that fails is an error, not a silent fallback.
 */
export function detectCli({ explicit = null, env = process.env.SCHEMATIC_REVIEW_CLI, spawnFn = spawnSync, logger = null } = {}) {
  const probe = (candidate) => {
    try {
      const res = spawnFn(candidate, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (res?.error || res?.status !== 0) return null;
      const help = String(res.stdout || '');
      const version = parseCliVersion(help);
      if (!version) return null;
      return { executable: candidate, command: candidate.split(/[\\/]/).pop().replace(/\.exe$/i, ''), version, versionText: version.join('.') };
    } catch {
      return null;
    }
  };
  const failExplicit = (reason) => {
    const err = new Error(`指定的 EasyEDA CLI 不可用（${explicit}）: ${reason}`);
    err.code = 'CLI_NOT_FOUND';
    throw err;
  };
  if (explicit) {
    if (!fs.existsSync(explicit)) failExplicit('文件不存在');
    const found = probe(explicit);
    if (!found) failExplicit('`--help` 执行失败，请确认是 EasyEDA Pro / 嘉立创EDA专业版 v4.1.70+ 的客户端');
    return found;
  }
  const names = env ? [env] : CLI_EDITIONS;
  for (const name of names) {
    const found = probe(name);
    if (found) return found;
  }
  for (const candidate of defaultCliCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const found = probe(candidate);
    if (found) return found;
  }
  if (logger) logger.warn?.('EasyEDA CLI not found');
  return null;
}

export function cliUnavailableMessage(projectPath) {
  return [
    '未找到 EasyEDA CLI（lceda-pro / easyeda-pro）。',
    'CLI 模式需要 EasyEDA Pro / 嘉立创EDA专业版桌面客户端 v4.1.70+，',
    '并把可执行文件放到 PATH 或用 --cli <路径> 指定。',
    projectPath ? `目标工程: ${projectPath}` : null,
    '（桥接模式仍可用：--source live；离线网表模式：--source file --netlist design.enet）',
  ].filter(Boolean).join('\n');
}

export function cliVersionTooOldMessage(found) {
  return `EasyEDA CLI 版本过低（${found.versionText || found.executable}），CLI 模式需要 ≥ ${CLI_MIN_VERSION.join('.')}；请升级客户端后在 --help 头部确认版本。`;
}

/** Open a project through the CLI. Returns the session descriptor. */
export function cliOpenProject(executable, projectPath, { headless = true, spawnFn = spawnSync, timeoutMs = 180000 } = {}) {
  const args = ['open', '--path', String(projectPath).replace(/\\/g, '/'), '--headless', headless ? 'true' : 'false'];
  const value = runCliJson(executable, args, { spawnFn, timeoutMs });
  const sessionId = value?.sessionId || value?.session_id;
  if (!sessionId) throw new Error('CLI open 未返回 sessionId（请确认客户端版本 ≥ 4.1.70）');
  return { sessionId, path: value.path || projectPath, headless, renderId: value.renderId || null };
}

/** Execute code in a CLI session. The code is an async function body. */
export function cliInvoke(executable, sessionId, code, { timeoutMs = 120000, spawnFn = spawnSync } = {}) {
  const args = ['invoke', '--session', sessionId, '--ext-uuid', 'eda', '--code', code, '--timeout', String(timeoutMs)];
  return runCliJson(executable, args, { spawnFn, timeoutMs: timeoutMs + 30000 });
}

/** Close a session we created. Best effort — never masks the real error. */
export function cliCloseSession(executable, sessionId, { spawnFn = spawnSync } = {}) {
  try {
    return runCliJson(executable, ['session', 'close', '--session', sessionId, '--destroy'], { spawnFn, timeoutMs: 60000 });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

const LIST_PAGES_CODE = `
return await (async () => {
  const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo().catch(() => []);
  const schematics = await eda.dmt_Schematic.getAllSchematicsInfo().catch(() => []);
  const current = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
  return { pages: pages || [], schematics: schematics || [], current: current || null };
})()`;

/**
 * Open a schematic page and wait until it is ready and active. Canvas APIs
 * (netlist, DRC, primitive traversal) only work on an opened + activated
 * document, and `open` leaves no document open in CLI sessions.
 */
function openPageCode(uuid) {
  return `
return await (async () => {
  const target = ${JSON.stringify(uuid)};
  const idOf = d => (d && (d.uuid || d.pageUuid || d.id)) || null;
  const tabId = await eda.dmt_EditorControl.openDocument(target);
  if (!tabId) return { ok: false, error: 'openDocument 未返回标签页 ID（打开失败）' };
  let ready = true;
  if (typeof eda.dmt_EditorControl.waitForDocumentReady === 'function') {
    ready = await eda.dmt_EditorControl.waitForDocumentReady(target, 60000);
  } else {
    const deadline = Date.now() + 60000;
    ready = false;
    while (Date.now() < deadline) {
      const st = typeof eda.dmt_EditorControl.getDocumentReadyState === 'function'
        ? await eda.dmt_EditorControl.getDocumentReadyState(tabId).catch(() => null)
        : null;
      const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
      if (st === 'ready' || idOf(cur) === target) { ready = true; break; }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!ready) return { ok: false, error: '文档未在 60s 内就绪' };
  let cur = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
  if (idOf(cur) !== target && typeof eda.dmt_EditorControl.activateDocument === 'function') {
    await eda.dmt_EditorControl.activateDocument(tabId).catch(() => null);
    cur = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
  }
  return { ok: true, tabId, doc: cur || null, activated: idOf(cur) === target };
})()`;
}

function pageLabelOfItem(page, schematicsById) {
  const schematicName = page.parentSchematicUuid ? (schematicsById.get(page.parentSchematicUuid) || null) : null;
  return [page.name || page.uuid, schematicName].filter(Boolean).join(' @ ');
}

function pageOptions(pages, schematicsById) {
  return pages.map(p => `${pageLabelOfItem(p, schematicsById)}（uuid: ${p.uuid}）`).join('；') || '（无）';
}

/**
 * Detect the CLI, open the project, then open a schematic page — `open` leaves
 * no document active, and canvas APIs require one. Page selection: `pageId`
 * (uuid, or a unique page name) when given, else the already-open document if
 * any, else the first page of the project. Returns an executor compatible with
 * bridge.execute() plus `pageInfo`; call `close()` when done.
 */
export async function openCliTransport({ projectPath, executable = null, headless = true, pageId = null, invokeTimeout = null, readyTimeoutMs = 60000, readyPollMs = 500, spawnFn = spawnSync, logger = null } = {}) {
  if (!projectPath) throw new Error('CLI 模式需要工程路径（.eprj3）');
  const found = detectCli({ explicit: executable, spawnFn, logger });
  if (!found) {
    const err = new Error(cliUnavailableMessage(projectPath));
    err.code = 'CLI_NOT_FOUND';
    throw err;
  }
  if (!versionAtLeast(found.version, CLI_MIN_VERSION)) {
    const err = new Error(cliVersionTooOldMessage(found));
    err.code = 'CLI_TOO_OLD';
    throw err;
  }
  logger?.info?.('cli open project', { executable: found.executable, version: found.versionText, projectPath });
  const session = cliOpenProject(found.executable, projectPath, { headless, spawnFn });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // `open` returns before the project tree has finished loading (~6–10 s on a
  // real project). Poll until the page list is populated before opening a page,
  // otherwise the first canvas invoke times out.
  const deadline = Date.now() + (readyTimeoutMs ?? 60000);
  let state = {};
  for (;;) {
    state = cliInvoke(found.executable, session.sessionId, LIST_PAGES_CODE, { timeoutMs: 60000, spawnFn }) || {};
    if (Array.isArray(state.pages) && state.pages.length) break;
    if (Date.now() >= deadline) break;
    logger?.info?.('project not ready yet, waiting', { waitMs: readyPollMs ?? 500 });
    await sleep(readyPollMs ?? 500);
  }
  const schematicsById = new Map((state.schematics || []).map(s => [s.uuid || s.schematicUuid || s.id, s.name || null]));
  const pages = (state.pages || []).map(p => ({
    uuid: p.uuid || p.pageUuid || p.id || null,
    name: p.name || p.pageName || null,
    parentSchematicUuid: p.parentSchematicUuid || null,
    schematicName: p.parentSchematicUuid ? (schematicsById.get(p.parentSchematicUuid) || null) : null,
  })).filter(p => p.uuid);
  if (!pages.length) {
    throw new Error(`工程中没有可打开的原理图图页（或工程在 ${Math.round((readyTimeoutMs ?? 60000) / 1000)}s 内未加载完成）：${projectPath}（无法读取网表/DRC）`);
  }
  const currentId = state.current && (state.current.uuid || state.current.pageUuid || state.current.id) || null;
  let target = null;
  let selectedBy = 'first';
  if (pageId) {
    target = pages.find(p => p.uuid === pageId) || null;
    if (!target) {
      const byName = pages.filter(p => p.name === pageId);
      if (byName.length === 1) target = byName[0];
      else if (byName.length > 1) {
        throw new Error(`图页名 "${pageId}" 不唯一，请用 uuid 指定：${pageOptions(byName, schematicsById)}`);
      } else {
        throw new Error(`图页不存在: ${pageId}。可用：${pageOptions(pages, schematicsById)}`);
      }
    }
    selectedBy = 'explicit';
  } else if (currentId && pages.some(p => p.uuid === currentId)) {
    target = pages.find(p => p.uuid === currentId);
    selectedBy = 'already-open';
  } else {
    target = pages[0];
  }

  if (selectedBy !== 'already-open') {
    logger?.info?.('cli open page', { uuid: target.uuid, name: target.name, schematicName: target.schematicName });
    const opened = cliInvoke(found.executable, session.sessionId, openPageCode(target.uuid), { timeoutMs: 120000, spawnFn }) || {};
    if (!opened.ok) {
      throw new Error(`打开图页失败（${pageLabelOfItem(target, schematicsById)}）: ${opened.error || '未知错误'}`);
    }
    const docId = opened.doc && (opened.doc.uuid || opened.doc.pageUuid || opened.doc.id) || null;
    if (docId && docId !== target.uuid) {
      throw new Error(`打开图页失败：当前文档不是目标图页（${pageLabelOfItem(target, schematicsById)}），请重新运行或改用 --page 指定`);
    }
    if (!docId && opened.activated === false) {
      logger?.warn?.('page opened but not reported as active', { uuid: target.uuid });
    }
    logger?.info?.('cli page ready', { uuid: target.uuid, tabId: opened.tabId || null });
  } else {
    logger?.info?.('cli page already open', { uuid: target.uuid });
  }

  if (!pageId && schematicsById.size > 1) {
    logger?.warn?.('工程包含多个原理图，默认审查第一个图页', {
      count: schematicsById.size,
      opened: pageLabelOfItem(target, schematicsById),
      available: pageOptions(pages, schematicsById),
    });
  }

  return {
    transport: 'cli',
    executable: found.executable,
    cliVersion: found.versionText,
    sessionId: session.sessionId,
    projectPath,
    pageInfo: {
      opened: { uuid: target.uuid, name: target.name, schematicName: target.schematicName },
      selectedBy,
      pages,
      schematics: [...schematicsById].map(([uuid, name]) => ({ uuid, name })),
    },
    execute: async (code, { timeoutMs = 120000 } = {}) => cliInvoke(found.executable, session.sessionId, code, { timeoutMs: invokeTimeout || timeoutMs, spawnFn }),
    close: () => cliCloseSession(found.executable, session.sessionId, { spawnFn }),
  };
}