import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, writeJson, writeText, createLogger, pageLabelOf, pageFileKeyOf,
} from './lib/util.mjs';
import { findBridge, execute, resolveWindow, launchBridge, bridgeUnavailableMessage } from './bridge.mjs';
import { openCliTransport } from './lib/cli-transport.mjs';

const COMPONENT_SNAPSHOT = `
async function __bbox(id) {
  try {
    const bb = await eda.sch_Primitive.getPrimitivesBBox([id]);
    if (!bb) return null;
    const { minX, minY, maxX, maxY } = bb;
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    if (maxX - minX <= 0 || maxY - minY <= 0) return null;
    return { minX, minY, maxX, maxY };
  } catch { return null; }
}
async function __pageSvg() {
  try {
    const f = await eda.sch_ManufactureData.getExportDocumentFile('page', 'SVG', undefined, 'Current Schematic Page');
    return f ? await f.text() : null;
  } catch { return null; }
}
async function __components(includeBBox) {
  const comps = await eda.sch_PrimitiveComponent.getAll('part');
  const list = comps.map(c => ({
    uid: (() => { try { return c.getState_UniqueId(); } catch { return undefined; } })(),
    designator: (() => { try { return c.getState_Designator(); } catch { return undefined; } })(),
    primitiveId: (() => { try { return c.getState_PrimitiveId(); } catch { return undefined; } })(),
  }));
  const withBBox = [];
  for (let i = 0; i < list.length; i += 16) {
    const chunk = list.slice(i, i + 16);
    const boxes = await Promise.all(chunk.map(e => (includeBBox && e.primitiveId) ? __bbox(e.primitiveId) : null));
    chunk.forEach((e, k) => withBBox.push({ ...e, bbox: boxes[k] }));
  }
  return withBBox;
}
async function __pins() {
  const comps = await eda.sch_PrimitiveComponent.getAll('part');
  const out = [];
  for (let i = 0; i < comps.length; i += 16) {
    const chunk = comps.slice(i, i + 16);
    const rows = await Promise.all(chunk.map(async c => {
      let pins = [];
      try { pins = (await c.getAllPins()) || []; } catch {}
      return {
        uid: (() => { try { return c.getState_UniqueId(); } catch { return undefined; } })(),
        designator: (() => { try { return c.getState_Designator(); } catch { return undefined; } })(),
        primitiveId: (() => { try { return c.getState_PrimitiveId(); } catch { return undefined; } })(),
        pins: pins.map(p => ({
          number: (() => { try { return p.getState_PinNumber(); } catch { return undefined; } })(),
          name: (() => { try { return p.getState_PinName(); } catch { return undefined; } })(),
          pinType: (() => { try { return p.getState_pinType(); } catch { return undefined; } })(),
          noConnect: (() => { try { return p.getState_NoConnected(); } catch { return undefined; } })(),
        })),
      };
    }));
    out.push(...rows);
  }
  return out;
}
`;

function viewBoxOf(svg) {
  const m = String(svg || '').match(/viewBox\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function pageItemName(page) {
  return page?.name || page?.title || page?.pageName || page?.documentName || null;
}

function pageNameOf(doc) {
  return pageItemName(doc) || 'Page';
}

/**
 * Build a uuid -> { name, parentSchematicUuid } catalog and
 * schematic uuid -> name map from every source the gateway returns.
 * getCurrentDocumentInfo() carries no display name, so page names must
 * be resolved through getAllSchematicPagesInfo()/getAllSchematicsInfo()
 * (or the project tree returned by getCurrentProjectInfo()).
 */
function pageCatalog(parts = {}) {
  const pages = new Map();
  const schematics = new Map();
  const addPage = (page, parentUuid) => {
    const uuid = page?.uuid || page?.pageUuid || page?.id;
    if (!uuid) return;
    const name = pageItemName(page);
    if (!pages.has(uuid)) {
      pages.set(uuid, { uuid, name, parentSchematicUuid: page.parentSchematicUuid || parentUuid || null });
    } else if (!pages.get(uuid).name && name) {
      pages.get(uuid).name = name;
    }
  };
  const addSchematic = (schematic) => {
    const uuid = schematic?.uuid || schematic?.schematicUuid || schematic?.id;
    if (uuid && schematic.name) schematics.set(uuid, schematic.name);
    for (const page of schematic?.page || schematic?.pages || []) addPage(page, uuid);
  };
  for (const schematic of parts.schematicsInfo || []) addSchematic(schematic);
  for (const page of parts.pagesInfo || []) addPage(page);
  for (const page of parts.pages || []) addPage(page);
  for (const item of parts.project?.data || []) {
    if (Array.isArray(item?.page)) addSchematic(item);
  }
  return { pages: [...pages.values()], schematics };
}

async function collectCurrentPage(exec, includeGeometry) {
  const code = `${COMPONENT_SNAPSHOT}
return await (async () => {
  const result = { ok: true };
  result.doc = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(e => ({ error: String(e) }));
  result.project = await eda.dmt_Project.getCurrentProjectInfo().catch(e => ({ error: String(e) }));
  try { result.version = await eda.sys_Environment.getEditorCurrentVersion(); } catch { result.version = null; }
  try { result.pagesInfo = await eda.dmt_Schematic.getAllSchematicPagesInfo(); } catch (e) { result.pagesInfoError = String(e); }
  try { result.schematicsInfo = await eda.dmt_Schematic.getAllSchematicsInfo(); } catch (e) { result.schematicsInfoError = String(e); }
  try {
    const f = await eda.sch_ManufactureData.getNetlistFile('design', 'JLCEDA');
    result.netlist = f ? await f.text() : null;
  } catch (e) { result.netlistError = String(e); }
  try {
    const f = await eda.sch_ManufactureData.getBomFile('bom', 'csv');
    result.bom = f ? await f.text() : null;
  } catch (e) { result.bomError = String(e); }
  try {
    result.drc = await eda.sch_Drc.check(false, false, true);
  } catch (e) { result.drcError = String(e); }
  try { result.pins = await __pins(); } catch (e) { result.pinsError = String(e); }
  result.components = await __components(${includeGeometry ? 'true' : 'false'}).catch(e => { result.componentsError = String(e); return []; });
  result.svg = await __pageSvg();
  return result;
})()`;
  return exec(code, { timeoutMs: 180000 });
}

async function collectPage(exec, page, includeGeometry) {
  const uuid = page.uuid || page.pageUuid || page.id;
  const uuidLiteral = uuid ? JSON.stringify(String(uuid)) : 'null';
  const code = `${COMPONENT_SNAPSHOT}
return await (async () => {
  const result = { ok: true };
  if (${uuidLiteral}) {
    try { await eda.dmt_EditorControl.openDocument(${uuidLiteral}); } catch (e) { result.openError = String(e); }
  }
  result.components = await __components(${includeGeometry ? 'true' : 'false'}).catch(e => []);
  result.svg = await __pageSvg();
  return result;
})()`;
  return exec(code, { timeoutMs: 180000 });
}

/** Bridge transport: discover/start the HTTP bridge and pick the EDA window. */
async function openBridgeTransport(options, log) {
  let bridge = null;
  if (options.bridgeUrl) {
    bridge = { url: options.bridgeUrl.replace(/\/$/, ''), port: Number(new URL(options.bridgeUrl).port || 49620) };
    try { await execute(bridge.url, 'return {ok:true}', { timeoutMs: 5000 }); } catch { /* health checked below */ }
  } else {
    bridge = await findBridge(options.bridgePort);
  }
  if (!bridge) {
    if (options.startBridge) bridge = await launchBridge(options.skillDir || path.resolve(process.cwd()));
    else throw new Error(bridgeUnavailableMessage());
  }
  const windowId = await resolveWindow(bridge.url, options.windowId);
  log.info('collect-live start', { transport: 'bridge', port: bridge.port, windowId });
  return {
    transport: 'bridge',
    bridgePort: bridge.port,
    windowId,
    execute: (code, { timeoutMs = 120000 } = {}) => execute(bridge.url, code, { windowId, timeoutMs }),
    close: null,
  };
}

/**
 * Transport selection: injected executor (tests) > CLI session (local .eprj3
 * opened through the desktop client's CLI) > HTTP bridge. All three run the
 * same read-only collection code; the project data is always read through the
 * editor APIs — the .eprj3 file format is never parsed by this skill.
 */
async function openTransport(options, log) {
  if (typeof options.executeCode === 'function') {
    return { transport: 'custom', ...(options.transportInfo || {}), execute: options.executeCode, close: options.closeTransport || null };
  }
  if (options.cli?.projectPath) {
    const cli = await openCliTransport({
      projectPath: options.cli.projectPath,
      executable: options.cli.executable || null,
      headless: options.cli.headless !== false,
      pageId: options.cli.pageId || null,
      invokeTimeout: options.cli.invokeTimeout || null,
      logger: log,
    });
    return {
      transport: 'cli',
      cliPath: cli.executable,
      cliVersion: cli.cliVersion,
      sessionId: cli.sessionId,
      projectPath: cli.projectPath,
      pageInfo: cli.pageInfo,
      execute: cli.execute,
      close: cli.close,
    };
  }
  return openBridgeTransport(options, log);
}

export async function collectLive(options = {}) {
  const log = options.logger || createLogger();
  const outDir = ensureDir(options.outDir || path.join(process.cwd(), 'tmp', 'schematic-review', 'live'));
  const t = await openTransport(options, log);
  try {
    return await collectWithTransport(options, outDir, log, t);
  } finally {
    if (t.close) {
      try {
        const closed = await t.close();
        log.info('transport closed', { transport: t.transport, closed });
      } catch (err) {
        log.warn('transport close failed', { transport: t.transport, error: String(err) });
      }
    }
  }
}

async function collectWithTransport(options, outDir, log, t) {
  const base = await collectCurrentPage(t.execute, options.geometry !== false);
  if (base.netlistError && !base.netlist) throw new Error(`网表导出失败: ${base.netlistError}`);
  if (!base.netlist) throw new Error('网表为空');
  writeText(path.join(outDir, 'design.enet'), base.netlist);
  if (base.bom) writeText(path.join(outDir, 'bom.csv'), base.bom);
  if (base.pins?.length) writeJson(path.join(outDir, 'pins.json'), base.pins);
  if (base.drc) writeJson(path.join(outDir, 'drc.json'), base.drc);

  const doc = base.doc || {};
  const docUuid = doc.uuid || doc.pageUuid || doc.id || null;
  const catalog = pageCatalog({
    pagesInfo: base.pagesInfo,
    schematicsInfo: base.schematicsInfo,
    project: base.project,
  });
  const currentPageItem = catalog.pages.find(p => p.uuid === docUuid) || null;
  const pageName = currentPageItem?.name || pageNameOf(doc);
  const schematicUuid = currentPageItem?.parentSchematicUuid || null;
  const schematicName = schematicUuid ? (catalog.schematics.get(schematicUuid) || null) : null;
  // Page keys carry the schematic dimension: two schematics can both have a
  // page named "P1", and a name-only key would overwrite geometry + page SVG.
  const usedPageKeys = new Set();
  const pageFileKey = pageFileKeyOf(schematicName, pageName, docUuid, usedPageKeys);
  const pages = {};
  const current = {
    pageUuid: docUuid,
    pageName,
    pageFileKey,
    schematicUuid,
    schematicName,
    pageWidth: null,
    pageHeight: null,
    svgViewBox: viewBoxOf(base.svg),
    svgPath: base.svg ? `page-${pageFileKey}.svg` : null,
    pngPath: null,
    components: {},
    designatorIndex: {},
    drcPrimitives: {},
  };
  if (base.svg) writeText(path.join(outDir, `page-${pageFileKey}.svg`), base.svg);
  for (const c of base.components || []) {
    if (!c.uid) continue;
    current.components[c.uid] = {
      designator: c.designator || '',
      primitiveId: c.primitiveId || null,
      bbox: c.bbox || null,
    };
    if (c.designator) {
      if (!current.designatorIndex[c.designator]) current.designatorIndex[c.designator] = [];
      current.designatorIndex[c.designator].push(c.uid);
    }
  }
  pages.__current__ = current;
  pages[pageFileKey] = current;

  if (options.mapPages) {
    try {
      let pageItems = catalog.pages;
      if (!pageItems.length) {
        const pageList = await t.execute(`
          return await (async () => {
            const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
            const schematics = await eda.dmt_Schematic.getAllSchematicsInfo().catch(() => []);
            const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
            return { pages: pages || [], schematics: schematics || [], current: cur };
          })()`, { timeoutMs: 30000 });
        const fallback = pageCatalog({ pagesInfo: pageList.pages, schematicsInfo: pageList.schematics });
        for (const [uuid, name] of fallback.schematics) {
          if (!catalog.schematics.has(uuid)) catalog.schematics.set(uuid, name);
        }
        pageItems = fallback.pages;
      }
      const originalUuid = current.pageUuid;
      for (const p of pageItems) {
        const pUuid = p.uuid || p.pageUuid || p.id || null;
        // The current page was already collected (with DRC/pins context);
        // reuse it instead of switching away and back.
        if (pUuid && pUuid === originalUuid && currentPageItem) continue;
        const pName = pageItemName(p) || 'Page';
        const pSchematicUuid = p.parentSchematicUuid || null;
        const pSchematicName = pSchematicUuid ? (catalog.schematics.get(pSchematicUuid) || null) : null;
        const pKey = pageFileKeyOf(pSchematicName, pName, pUuid, usedPageKeys);
        const snap = await collectPage(t.execute, p, options.geometry !== false);
        const pg = {
          pageUuid: pUuid,
          pageName: pName,
          pageFileKey: pKey,
          schematicUuid: pSchematicUuid,
          schematicName: pSchematicName,
          pageWidth: null,
          pageHeight: null,
          svgViewBox: viewBoxOf(snap.svg),
          svgPath: snap.svg ? `page-${pKey}.svg` : null,
          pngPath: null,
          components: {},
          designatorIndex: {},
          drcPrimitives: {},
        };
        if (snap.svg) writeText(path.join(outDir, `page-${pKey}.svg`), snap.svg);
        for (const c of snap.components || []) {
          if (!c.uid) continue;
          pg.components[c.uid] = { designator: c.designator || '', primitiveId: c.primitiveId || null, bbox: c.bbox || null };
          if (c.designator) {
            if (!pg.designatorIndex[c.designator]) pg.designatorIndex[c.designator] = [];
            pg.designatorIndex[c.designator].push(c.uid);
          }
        }
        pages[pKey] = pg;
      }
      if (originalUuid) {
        await t.execute(`
          return await (async () => { await eda.dmt_EditorControl.openDocument(${JSON.stringify(String(originalUuid))}); return { ok: true }; })()`,
          { timeoutMs: 30000 }).catch(() => null);
      }
    } catch (err) {
      log.warn('map-pages failed', { error: String(err) });
    }
  }

  // DRC primitive bboxes (optional, best effort).
  if (Array.isArray(base.drc) && base.drc.length) {
    const ids = [...new Set(base.drc.flatMap(d => (d.primitives || []).map(p => p.primitiveId)).filter(Boolean))].slice(0, 200);
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const results = await Promise.all(chunk.map(id => t.execute(`
          return await (async () => { try { return await eda.sch_Primitive.getPrimitivesBBox([${JSON.stringify(id)}]); } catch { return null; } })()`,
        { timeoutMs: 15000 }).catch(() => null)));
      chunk.forEach((id, k) => {
        const bb = results[k];
        if (bb && Number.isFinite(bb.minX) && bb.maxX > bb.minX && bb.maxY > bb.minY) {
          current.drcPrimitives[id] = { bbox: { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY } };
        }
      });
    }
  }

  const geometry = {
    currentPage: pageName,
    currentSchematic: schematicName,
    pages,
  };
  writeJson(path.join(outDir, 'geometry.json'), geometry);

  const project = base.project || {};
  const summary = {
    doc,
    project,
    version: base.version || null,
    netlistFile: 'design.enet',
    bomAvailable: Boolean(base.bom),
    drcAvailable: Array.isArray(base.drc),
    pinsAvailable: Array.isArray(base.pins) && base.pins.length > 0,
    geometryAvailable: true,
    mapPages: Boolean(options.mapPages),
    pageName,
    pageFileKey,
    schematicUuid,
    schematicName,
    pageLabel: pageLabelOf({ pageName, schematicName }),
    transport: t.transport,
    windowId: t.windowId || null,
    bridgePort: t.bridgePort || null,
    cliPath: t.cliPath || null,
    cliVersion: t.cliVersion || null,
    sessionId: t.sessionId || null,
    projectPath: t.projectPath || null,
    openedPage: t.pageInfo?.opened || null,
    pageSelection: t.pageInfo?.selectedBy || null,
    pageList: t.pageInfo?.pages || [],
    schematicCount: t.pageInfo?.schematics?.length ?? null,
  };
  writeJson(path.join(outDir, 'collect.json'), summary);
  log.info('collect-live done', summary);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(process.cwd(), 'tmp', 'schematic-review', 'live');
  collectLive({
    outDir,
    mapPages: args.includes('--map-pages'),
    startBridge: args.includes('--start-bridge'),
    bridgeUrl: args.includes('--bridge-url') ? args[args.indexOf('--bridge-url') + 1] : undefined,
    windowId: args.includes('--window-id') ? args[args.indexOf('--window-id') + 1] : undefined,
    skillDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  }).then(() => console.log(`collect written: ${outDir}`)).catch(err => {
    console.error(err.message);
    process.exit(2);
  });
}
