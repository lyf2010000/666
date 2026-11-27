#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, numArg, ensureDir, readJson, writeJson, uniqueRunDir, timestampId,
  createLogger, skillVersion, fileEntry,
} from './lib/util.mjs';
import { buildModel } from './parse-netlist.mjs';
import { lintModel } from './lint.mjs';
import { buildPackets, writePackets } from './build-packets.mjs';
import { mergeFindings } from './merge-findings.mjs';
import { captureScreenshots } from './capture-screenshots.mjs';
import { renderReport } from './render-html.mjs';
import { collectLive } from './collect-live.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = skillVersion();

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

function usage() {
  return `easyeda-schematic-review ${VERSION}

用法:
  review.mjs run --source live|cli|file [--mode quick|standard|strict] [--out DIR]
  review.mjs run --source cli --project <本地工程.eprj3> --out DIR
  review.mjs collect --source live|cli|file --netlist design.enet --out DIR
  review.mjs collect --source cli --project <本地工程.eprj3> [--page <图页uuid|名称>] --out DIR
  review.mjs lint --out DIR
  review.mjs packets --out DIR
  review.mjs merge --out DIR [--ai-dir DIR]
  review.mjs capture --out DIR
  review.mjs report --out DIR [--lang zh|en] [--self-contained]
  review.mjs ai-done --out DIR --packet <fileKey> --status done|failed

常用参数:
  --netlist <file>      离线 .enet
  --project <file>      CLI 模式：本地工程 .eprj3 路径（请向用户确认；不解析文件格式，通过 CLI API 读取）
  --cli <exe>           CLI 可执行文件（默认自动探测 lceda-pro / easyeda-pro）
  --cli-show            CLI 模式显示编辑器窗口（默认 headless 打开）
  --page <uuid|名称>    CLI 模式指定要审查的原理图图页（默认第一个图页）
  --invoke-timeout <ms> CLI 模式单次 invoke 超时（默认按各步骤内置值，最大 30 分钟）
  --full                全量输出：不限审查包/结论/截图/开放问题，未审完的 AI 包视为失败
  --bom <file>          BOM CSV
  --drc <file>          DRC JSON
  --scope <expr>        page:P1 / net:VCC / designator:U1 / category:power
  --focus <expr>        审查焦点（传给 packets）
  --pins/--no-pins      live 采集/跳过 pins.json（默认采集）
  --map-pages           多页映射与页面 SVG 导出（会切换图页并恢复）
  --no-screenshots      跳过截图
  --image-format svg|png
  --max-findings 30     P0/P1 不截断
  --max-screenshots 30  P0/P1 不截断
  --max-p0 N / --max-p1 N / --strict-exit   CI 阈值（超限退出 10）
  --fail-partial        partial 视为失败（退出 6）
  --resume              standard/strict 的 AI 完成后继续
  --self-contained      报告单文件（截图 base64）
  --start-bridge        明确同意后由本 skill 启动 Bridge
  --model <name>        审查所用模型（也可用 SCHEMATIC_REVIEW_MODEL）
  --tokens-in N         本次审查输入 Token（写入 review-context.json）
  --tokens-out N        本次审查输出 Token（写入 review-context.json）
`;
}

function logLine(outDir, level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  try { fs.appendFileSync(path.join(outDir, 'run.log'), line, 'utf8'); } catch { /* ignore */ }
  if (level === 'error') console.error(msg);
  else if (process.env.SCHEMATIC_REVIEW_VERBOSE) console.error(line.trim());
}

function manifestPath(outDir) { return path.join(outDir, 'manifest.json'); }

function reviewContextPath(outDir) { return path.join(outDir, 'review-context.json'); }

/** Record review metadata (model, start/end time, token usage) for the report. */
function ensureReviewContext(outDir, opts, { endedAt = null } = {}) {
  const file = reviewContextPath(outDir);
  const current = fs.existsSync(file) ? readJson(file, {}) : {};
  const manifest = fs.existsSync(manifestPath(outDir)) ? readJson(manifestPath(outDir), {}) : {};
  const next = {
    schemaVersion: '1.0',
    ...current,
    skillVersion: current.skillVersion || VERSION,
    promptVersion: current.promptVersion || '1.0',
  };
  if (!next.startedAt) next.startedAt = manifest.runAt || new Date().toISOString();
  const model = opts.model || process.env.SCHEMATIC_REVIEW_MODEL || current.model || manifest.model;
  if (model && model !== 'unknown') next.model = model;
  const tokensIn = opts.tokensIn ?? numArg(process.env.SCHEMATIC_REVIEW_TOKENS_IN, null);
  const tokensOut = opts.tokensOut ?? numArg(process.env.SCHEMATIC_REVIEW_TOKENS_OUT, null);
  if (tokensIn != null || tokensOut != null) {
    const input = tokensIn ?? next.tokens?.input ?? 0;
    const output = tokensOut ?? next.tokens?.output ?? 0;
    next.tokens = { input, output, total: input + output };
  }
  if (endedAt && !next.endedAt) next.endedAt = endedAt;
  writeJson(file, next);
  return next;
}

function updateManifest(outDir, patch) {
  const file = manifestPath(outDir);
  const current = fs.existsSync(file) ? readJson(file, {}) : {};
  const next = { ...current, ...patch };
  writeJson(file, next);
  return next;
}

function initManifest(outDir, opts, source) {
  const runId = opts.runId || path.basename(outDir);
  const now = new Date().toISOString();
  const manifest = {
    skill: 'easyeda-schematic-review',
    skillVersion: VERSION,
    runId,
    runAt: now,
    source: opts.source,
    transport: opts.source === 'cli' ? 'cli' : (opts.source === 'live' ? 'bridge' : 'file'),
    projectPath: opts.project || null,
    full: Boolean(opts.full),
    mode: opts.mode,
    noAi: opts.noAi,
    status: 'initialized',
    windowId: opts.windowId || null,
    project: source.project || null,
    board: source.board || null,
    schematic: source.schematic || null,
    netlistType: 'JLCEDA',
    netlistVersion: source.netlistVersion || null,
    edaVersion: source.edaVersion || null,
    model: opts.model || process.env.SCHEMATIC_REVIEW_MODEL || 'unknown',
    promptVersion: '1.0',
    ruleCatalogVersion: '1.0',
    files: [],
    coverage: {},
    screenshots: {},
    warnings: [],
  };
  writeJson(manifestPath(outDir), manifest);
  return manifest;
}

function sourceFromCollect(collect) {
  const doc = collect?.doc || {};
  const project = collect?.project || {};
  return {
    project: project.name || project.projectName || project.title || doc.projectName || null,
    board: project.boardName || project.board || doc.boardName || null,
    schematic: project.schematicName || project.schematic || doc.schematicName || collect?.schematicName || doc.name || null,
    edaVersion: collect?.version || null,
  };
}

function readNetlistJson(file, log) {
  if (!fs.existsSync(file)) throw new CliError(`网表文件不存在: ${file}`, 3);
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (err) {
    if (/\.net$/i.test(file)) throw new CliError('v1 不支持 Protel2 .net，请导出 .enet（JLCEDA 类型）', 3);
    throw new CliError(`网表解析失败: ${err.message}`, 4);
  }
}

function loadDrc(file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = readJson(file, []);
  return Array.isArray(data) ? data : (data.result || data.drc || []);
}

function loadGeometry(outDir) {
  const f = path.join(outDir, 'geometry.json');
  return fs.existsSync(f) ? readJson(f) : null;
}

async function doCollect(opts, outDir, log) {
  initManifest(outDir, opts, {});
  updateManifest(outDir, { status: 'collecting' });
  let collectInfo = null;
  if (opts.source === 'live' || opts.source === 'cli') {
    if (opts.source === 'cli') {
      if (!opts.project) throw new CliError('CLI 模式需要 --project <本地工程.eprj3>（请先向用户确认工程路径）', 3);
      if (!fs.existsSync(opts.project)) throw new CliError(`工程路径不存在: ${opts.project}`, 3);
    }
    try {
      collectInfo = await collectLive({
        outDir,
        mapPages: opts.mapPages,
        startBridge: opts.startBridge,
        bridgeUrl: opts.bridgeUrl,
        bridgePort: opts.bridgePort,
        windowId: opts.windowId,
        geometry: !opts.noScreenshots,
        skillDir: SKILL_DIR,
        logger: log,
        cli: opts.source === 'cli' ? {
          projectPath: opts.project,
          executable: opts.cliPath,
          headless: !opts.cliShow,
          pageId: opts.page,
          invokeTimeout: opts.invokeTimeout,
        } : null,
      });
    } catch (err) {
      throw new CliError(err.message || String(err), 2);
    }
    opts.windowId = collectInfo.windowId || null;
  } else {
    if (!opts.netlist) throw new CliError('离线模式需要 --netlist <design.enet>', 3);
    if (!fs.existsSync(opts.netlist)) throw new CliError(`网表文件不存在: ${opts.netlist}`, 3);
    if (/\.net$/i.test(opts.netlist)) {
      throw new CliError('v1 不支持 Protel2 .net，请在 EasyEDA 中导出 .enet（JLCEDA 类型）', 3);
    }
    fs.copyFileSync(opts.netlist, path.join(outDir, 'design.enet'));
    if (opts.bom && fs.existsSync(opts.bom)) fs.copyFileSync(opts.bom, path.join(outDir, 'bom.csv'));
    if (opts.drc && fs.existsSync(opts.drc)) fs.copyFileSync(opts.drc, path.join(outDir, 'drc.json'));
  }
  const netlist = readNetlistJson(path.join(outDir, 'design.enet'), log);
  const pinsFile = opts.pins && fs.existsSync(path.join(outDir, 'pins.json')) ? path.join(outDir, 'pins.json') : null;
  const drcPath = path.join(outDir, 'drc.json');
  const drcProvided = fs.existsSync(drcPath);
  const drc = drcProvided ? loadDrc(drcPath) : [];
  const geometry = loadGeometry(outDir);
  const source = (opts.source === 'live' || opts.source === 'cli') ? sourceFromCollect(collectInfo) : {
    project: opts.netlist ? path.basename(opts.netlist, path.extname(opts.netlist)) : null,
    board: null, schematic: null, edaVersion: null,
  };
  let model;
  try {
    model = buildModel(netlist, {
      pinsFile,
      drc,
      drcProvided,
      geometry,
      source: {
        mode: opts.source,
        project: source.project,
        board: source.board,
        schematic: source.schematic,
        netlistType: 'JLCEDA',
        netlistVersion: netlist.version,
      },
      logger: log,
    });
  } catch (err) {
    throw new CliError(err.message || String(err), 4);
  }
  writeJson(path.join(outDir, 'model.json'), model);
  updateManifest(outDir, {
    status: 'collected',
    windowId: opts.windowId || null,
    transport: collectInfo?.transport || (opts.source === 'file' ? 'file' : null),
    projectPath: collectInfo?.projectPath || opts.project || null,
    cliPath: collectInfo?.cliPath || null,
    cliVersion: collectInfo?.cliVersion || null,
    sessionId: collectInfo?.sessionId || null,
    openedPage: collectInfo?.openedPage || null,
    project: source.project,
    board: source.board,
    schematic: source.schematic,
    edaVersion: source.edaVersion,
    netlistVersion: netlist.version || null,
    source: opts.source,
    files: collectManifestFiles(outDir),
  });
  logLine(outDir, 'info', 'collect done', { components: model.stats.components, nets: model.stats.nets });
  return model;
}

function doLint(opts, outDir, log) {
  const model = readJson(path.join(outDir, 'model.json'));
  const bomFile = fs.existsSync(path.join(outDir, 'bom.csv')) ? path.join(outDir, 'bom.csv') : null;
  const lint = lintModel(model, { mode: opts.mode, bomFile, logger: log, maxQuestions: opts.maxQuestions });
  writeJson(path.join(outDir, 'lint.json'), lint);
  updateManifest(outDir, { status: 'linted', ruleCatalogVersion: '1.0', files: collectManifestFiles(outDir) });
  logLine(outDir, 'info', 'lint done', { findings: lint.findings.length, suppressed: lint.coverage.suppressedFindings });
  return lint;
}

function doPackets(opts, outDir, log) {
  ensureDir(path.join(outDir, 'ai'));
  const model = readJson(path.join(outDir, 'model.json'));
  const lint = readJson(path.join(outDir, 'lint.json'), { findings: [], openQuestions: [] });
  const packets = buildPackets(model, lint, {
    maxPackets: opts.maxPackets,
    packetTokenLimit: opts.packetTokenLimit,
    focus: opts.focus,
    neighborLimit: opts.full ? Infinity : undefined,
    questionLimit: opts.full ? Infinity : undefined,
  });
  const manifest = writePackets(outDir, packets, { focus: opts.focus });
  updateManifest(outDir, { status: 'awaiting_ai', files: collectManifestFiles(outDir) });
  logLine(outDir, 'info', 'packets done', { count: manifest.count });
  return manifest;
}

function doMerge(opts, outDir, log) {
  const aiDir = opts.aiDir || path.join(outDir, 'ai');
  ensureDir(aiDir);
  const result = mergeFindings({
    outDir,
    aiDir,
    lang: opts.lang,
    scope: opts.scope,
    maxFindings: opts.maxFindings,
    maxQuestions: opts.maxQuestions,
    mode: opts.mode,
    runId: opts.runId || path.basename(outDir),
    logger: log,
  });
  updateManifest(outDir, {
    status: 'merged',
    coverage: result.coverage,
    files: collectManifestFiles(outDir),
  });
  logLine(outDir, 'info', 'merge done', { findings: result.findings.length });
  return result;
}

function doCapture(opts, outDir, log) {
  if (opts.noScreenshots) {
    updateManifest(outDir, { status: 'captured', screenshots: { generated: 0, failed: 0, skipped: 0 } });
    return { generated: 0, failed: 0, skipped: 0 };
  }
  if (opts.raw['image-format'] === 'png') {
    logLine(outDir, 'warn', 'PNG 截图属于 v1.1 可选能力，当前回退 SVG');
  }
  const result = captureScreenshots({ outDir, maxScreenshots: opts.maxScreenshots });
  updateManifest(outDir, { status: 'captured', screenshots: result });
  logLine(outDir, 'info', 'capture done', result);
  return result;
}

function doReport(opts, outDir, log) {
  const context = ensureReviewContext(outDir, opts, { endedAt: new Date().toISOString() });
  const result = renderReport({ outDir, lang: opts.lang, selfContained: opts.selfContained });
  if (opts.jsonOut) {
    ensureDir(path.dirname(path.resolve(opts.jsonOut)));
    fs.copyFileSync(path.join(outDir, 'report.json'), opts.jsonOut);
  }
  updateManifest(outDir, {
    status: 'done',
    model: context.model || undefined,
    files: collectManifestFiles(outDir),
    coverage: readJson(path.join(outDir, 'findings.final.json')).coverage,
  });
  logLine(outDir, 'info', 'report done', { file: result.htmlFile });
  return result;
}

function collectManifestFiles(outDir) {
  const entries = [];
  const add = (rel, type) => { const e = fileEntry(outDir, rel, type); if (e) entries.push(e); };
  add('design.enet', 'netlist');
  add('model.json', 'model');
  add('lint.json', 'lint');
  add('findings.final.json', 'other');
  add('report.html', 'report');
  add('report.json', 'other');
  add('manifest.json', 'other');
  add('run.log', 'log');
  for (const f of fs.existsSync(path.join(outDir, 'ai')) ? fs.readdirSync(path.join(outDir, 'ai')) : []) {
    if (/\.json$/i.test(f)) add(path.join('ai', f), 'ai');
  }
  for (const f of fs.existsSync(path.join(outDir, 'packets')) ? fs.readdirSync(path.join(outDir, 'packets')) : []) {
    if (/\.json$/i.test(f)) add(path.join('packets', f), 'other');
  }
  for (const f of fs.existsSync(path.join(outDir, 'screenshots')) ? fs.readdirSync(path.join(outDir, 'screenshots')) : []) {
    if (f.endsWith('.svg')) add(path.join('screenshots', f), 'screenshot');
  }
  return entries;
}

function checkThresholds(opts, outDir) {
  const final = readJson(path.join(outDir, 'findings.final.json'));
  if (opts.failPartial && final.coverage?.partial) return 6;
  const count = sev => final.findings.filter(f => f.severity === sev).length;
  const maxP0 = opts.strictExit ? 0 : opts.maxP0;
  if (maxP0 != null && count('P0') > maxP0) return 10;
  if (opts.maxP1 != null && count('P1') > opts.maxP1) return 10;
  return 0;
}

function normalizeOpts(argv) {
  const raw = parseArgs(argv);
  const mode = raw.mode || 'standard';
  if (!['quick', 'standard', 'strict'].includes(mode)) throw new CliError(`未知 --mode: ${mode}`, 1);
  const full = Boolean(raw.full);
  const source = raw.source || (raw.netlist ? 'file' : (raw.project ? 'cli' : 'live'));
  if (!['live', 'cli', 'file'].includes(source)) throw new CliError(`未知 --source: ${source}`, 1);
  return {
    raw,
    source,
    mode,
    out: raw.out || null,
    netlist: raw.netlist || null,
    project: raw.project || null,
    cliPath: raw.cli || process.env.SCHEMATIC_REVIEW_CLI || null,
    cliShow: Boolean(raw['cli-show']),
    page: raw.page || null,
    bom: raw.bom || null,
    drc: raw.drc || null,
    aiDir: raw['ai-dir'] || null,
    jsonOut: raw['json-out'] || null,
    scope: raw.scope || null,
    focus: raw.focus || null,
    lang: raw.lang === 'en' ? 'en' : 'zh',
    pins: raw['no-pins'] ? false : true,
    noScreenshots: Boolean(raw['no-screenshots']),
    selfContained: Boolean(raw['self-contained']),
    mapPages: Boolean(raw['map-pages']),
    startBridge: Boolean(raw['start-bridge']),
    bridgeUrl: raw['bridge-url'] || null,
    bridgePort: raw['bridge-port'] || null,
    windowId: raw['window-id'] || null,
    noAi: Boolean(raw['no-ai']) || mode === 'quick',
    strictExit: Boolean(raw['strict-exit']),
    // --full：解除覆盖类上限（审查包/结论/截图/开放问题全部保留），
    // 并把“未审完的 AI 包”视为失败，防止产出“假完整”报告。
    full,
    failPartial: Boolean(raw['fail-partial']) || full,
    maxP0: numArg(raw['max-p0'], null),
    maxP1: numArg(raw['max-p1'], null),
    maxFindings: raw['max-findings'] != null ? numArg(raw['max-findings'], 30) : (full ? Infinity : 30),
    maxScreenshots: raw['max-screenshots'] != null ? numArg(raw['max-screenshots'], 30) : (full ? Infinity : 30),
    maxPackets: raw['max-packets'] != null ? numArg(raw['max-packets'], 20) : (full ? Infinity : 20),
    maxQuestions: full ? Infinity : 15,
    invokeTimeout: numArg(raw['invoke-timeout'], null),
    resume: Boolean(raw.resume),
    model: raw.model || process.env.SCHEMATIC_REVIEW_MODEL || null,
    tokensIn: numArg(raw['tokens-in'], null),
    tokensOut: numArg(raw['tokens-out'], null),
    runId: null,
  };
}

function prepareOutDir(opts) {
  if (opts.out) {
    ensureDir(opts.out);
    opts.runId = path.basename(path.resolve(opts.out));
    return path.resolve(opts.out);
  }
  const base = path.join(process.cwd(), 'tmp', 'schematic-review');
  ensureDir(base);
  const id = timestampId();
  const dir = uniqueRunDir(base, id);
  opts.runId = path.basename(dir);
  return ensureDir(dir);
}

async function commandRun(opts, log) {
  const outDir = prepareOutDir(opts);
  ensureReviewContext(outDir, opts);
  if (opts.resume) {
    if (!fs.existsSync(path.join(outDir, 'manifest.json'))) throw new CliError(`--resume 需要已有运行目录: ${outDir}`, 1);
    const manifest = readJson(path.join(outDir, 'manifest.json'));
    opts.mode = manifest.mode || opts.mode;
    opts.scope = opts.scope || manifest.scope || null;
    logLine(outDir, 'info', 'resume', { mode: opts.mode });
    doMerge(opts, outDir, log);
    doCapture(opts, outDir, log);
    doReport(opts, outDir, log);
    const code = checkThresholds(opts, outDir);
    console.log(`report: ${path.join(outDir, 'report.html')}`);
    return code;
  }
  await doCollect(opts, outDir, log);
  doLint(opts, outDir, log);
  if (opts.mode === 'quick' || opts.noAi) {
    ensureDir(path.join(outDir, 'ai'));
    doMerge(opts, outDir, log);
    doCapture(opts, outDir, log);
    doReport(opts, outDir, log);
    const code = checkThresholds(opts, outDir);
    console.log(`report: ${path.join(outDir, 'report.html')}`);
    return code;
  }
  doPackets(opts, outDir, log);
  updateManifest(outDir, { status: 'awaiting_ai', scope: opts.scope });
  console.log(`已生成 ${outDir}/packets/（status=awaiting_ai）。`);
  console.log('下一步：逐包审查 packets/*.json，写入 ai/findings.ai.<fileKey>.json，并执行：');
  console.log(`  node ${path.join(SKILL_DIR, 'scripts', 'review.mjs')} ai-done --out "${outDir}" --packet <fileKey> --status done`);
  console.log(`  node ${path.join(SKILL_DIR, 'scripts', 'review.mjs')} run --resume --out "${outDir}"`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  if (command === '--version' || command === '-v') { console.log(VERSION); return 0; }
  if (command === 'help' || command === '--help' || command === '-h') { console.log(usage()); return 0; }
  const opts = normalizeOpts(argv.slice(1));
  const log = createLogger();
  if (opts.raw.help) { console.log(usage()); return 0; }

  if (command === 'ai-done') {
    const outDir = opts.out;
    if (!outDir) throw new CliError('ai-done 需要 --out <runDir>', 1);
    const packet = opts.raw.packet;
    const status = opts.raw.status;
    if (!packet || !['done', 'failed'].includes(status)) throw new CliError('ai-done 需要 --packet <fileKey> --status done|failed', 1);
    const progressFile = path.join(outDir, 'progress.json');
    const progress = fs.existsSync(progressFile) ? readJson(progressFile, {}) : {};
    progress[packet] = { status, at: new Date().toISOString() };
    writeJson(progressFile, progress);
    ensureReviewContext(outDir, opts);
    logLine(outDir, 'info', 'ai-done', { packet, status });
    console.log(`progress: ${packet} -> ${status}`);
    return 0;
  }

  if (command === 'run') return await commandRun(opts, log);

  const outDir = prepareOutDir(opts);
  ensureReviewContext(outDir, opts);
  if (command === 'collect') { await doCollect(opts, outDir, log); console.log(`collected: ${outDir}`); return 0; }
  if (command === 'lint') { doLint(opts, outDir, log); console.log(`lint: ${path.join(outDir, 'lint.json')}`); return 0; }
  if (command === 'packets') { doPackets(opts, outDir, log); console.log(`packets: ${path.join(outDir, 'packets')}`); return 0; }
  if (command === 'merge') { doMerge(opts, outDir, log); console.log(`merged: ${path.join(outDir, 'findings.final.json')}`); return 0; }
  if (command === 'capture') { doCapture(opts, outDir, log); console.log(`captured: ${path.join(outDir, 'screenshots')}`); return 0; }
  if (command === 'report') {
    doReport(opts, outDir, log);
    console.log(`report: ${path.join(outDir, 'report.html')}`);
    return checkThresholds(opts, outDir);
  }
  throw new CliError(`未知命令: ${command}\n${usage()}`, 1);
}

main().then(code => {
  process.exitCode = code || 0;
}).catch(err => {
  const code = err instanceof CliError ? err.code : (err?.code || 1);
  console.error(err.message || String(err));
  if (process.env.SCHEMATIC_REVIEW_VERBOSE && err.stack) console.error(err.stack);
  process.exitCode = code;
});
