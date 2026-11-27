import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, escapeXml, ensureDir, pageLabelOf } from './lib/util.mjs';

function isFiniteBox(b) {
  return b && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) &&
    b.maxX > b.minX && b.maxY > b.minY;
}

function unionBoxes(boxes) {
  const valid = boxes.filter(isFiniteBox);
  if (!valid.length) return null;
  return {
    minX: Math.min(...valid.map(b => b.minX)),
    minY: Math.min(...valid.map(b => b.minY)),
    maxX: Math.max(...valid.map(b => b.maxX)),
    maxY: Math.max(...valid.map(b => b.maxY)),
  };
}

/** UIDs the finding points at: explicit location.uids plus the pins of its nets. */
function findingUids(finding, model) {
  const uids = new Set(finding.location?.uids || []);
  for (const netName of finding.location?.nets || []) {
    const net = (model.nets || []).find(n => n.name === netName);
    if (!net) continue;
    if ((net.isPower || net.isGround) && net.pins.length > 12) continue;
    for (const p of net.pins.slice(0, 12)) uids.add(p.uid);
  }
  return [...uids];
}

/**
 * A candidate page is usable only when the finding's evidence actually lives
 * there. EasyEDA primitive uids are page-local, so the same uid on another
 * page is a different physical part: every present uid's geometry designator
 * must agree with the netlist, and the finding's explicit uids must also
 * agree with its designators. Net-derived neighbor uids are not required to
 * be listed in designators. Designator-only findings fall back to the page's
 * designatorIndex, trusting only uids the netlist confirms. Prefer a
 * placeholder over drawing a box on a wrong page.
 */
function pageMatchesFinding(page, finding, model, uids) {
  const comps = page?.components || {};
  const designators = new Set(finding.location?.designators || []);
  const present = uids.filter(u => comps[u]);
  if (uids.length) {
    if (!present.length) return false;
    for (const u of present) {
      const gd = comps[u]?.designator;
      const comp = model.components.find(c => c.uid === u);
      if (comp?.designator && gd && comp.designator !== gd) return false;
    }
    const explicit = (finding.location?.uids || []).filter(u => comps[u]);
    if (explicit.length) {
      return explicit.every(u => {
        const gd = comps[u]?.designator;
        return !designators.size || !gd || designators.has(gd);
      });
    }
    if (designators.size) {
      return present.some(u => designators.has(comps[u]?.designator));
    }
    return true;
  }
  for (const d of designators) {
    const indexed = page?.designatorIndex?.[d] || [];
    if (indexed.some(u => {
      const comp = model.components.find(c => c.uid === u);
      return comp && comp.designator === d;
    })) return true;
  }
  // No uid/designator evidence to verify (e.g. unresolved net-only finding):
  // allow the page; collectBoxes will placeholder if nothing can be located.
  return !designators.size;
}

export function choosePage(finding, model) {
  const pages = model.geometry?.pages || {};
  const entries = Object.entries(pages);
  if (!entries.length) return { key: null, page: null, mismatch: false };
  const uids = findingUids(finding, model);
  const candidates = [];
  const push = (key, page) => {
    if (page && !candidates.some(c => c.key === key)) candidates.push({ key, page });
  };
  // Priority: declared pages (key / pageName / pageFileKey / "Schematic / Page"
  // label), then pages holding the finding's uids, then __current__, then all.
  for (const p of finding.location?.pages || []) {
    if (pages[p]) push(p, pages[p]);
    for (const [key, page] of entries) {
      if (page.pageName === p || page.pageFileKey === p || pageLabelOf(page) === p) push(key, page);
    }
  }
  for (const [key, page] of entries) {
    if (uids.some(u => page.components?.[u])) push(key, page);
  }
  if (pages.__current__) push('__current__', pages.__current__);
  for (const [key, page] of entries) push(key, page);
  // Verify each candidate; a name hit on the wrong schematic's page must not
  // win over the page that actually contains the evidence.
  for (const c of candidates) {
    if (pageMatchesFinding(c.page, finding, model, uids)) return { key: c.key, page: c.page, mismatch: false };
  }
  return { key: null, page: null, mismatch: true };
}

function collectUids(finding, page, model) {
  const uids = new Set(findingUids(finding, model));
  for (const d of finding.location?.designators || []) {
    for (const u of page?.designatorIndex?.[d] || []) {
      // Page-local uids: another schematic's page can index the same
      // designator to a uid the netlist does not know (or knows as a
      // different part). Only trust netlist-confirmed uids.
      const comp = model.components.find(c => c.uid === u);
      if (comp && comp.designator === d) uids.add(u);
    }
  }
  return [...uids].filter(u => page?.components?.[u]);
}

function collectBoxes(finding, page, model, uids) {
  const boxes = [];
  for (const uid of uids) {
    const b = page.components?.[uid]?.bbox;
    if (isFiniteBox(b)) boxes.push({ ...b, uid });
  }
  if (!boxes.length) {
    for (const e of finding.evidence || []) {
      if (e.kind === 'drc' && e.primitiveId) {
        const b = page.drcPrimitives?.[e.primitiveId]?.bbox;
        if (isFiniteBox(b)) boxes.push({ ...b, drcPrimitiveId: e.primitiveId });
      }
    }
  }
  return boxes;
}

function adjustRegion(finding, page, boxes) {
  let region = unionBoxes(boxes);
  if (!region) return null;
  const pw = Number(page.pageWidth) || 0;
  const ph = Number(page.pageHeight) || 0;
  if (pw > 0 && ph > 0 && (region.maxX - region.minX) * (region.maxY - region.minY) > pw * ph * 0.7) {
    const first = boxes[0];
    if (first) region = { minX: first.minX, minY: first.minY, maxX: first.maxX, maxY: first.maxY };
  }
  const pad = 40;
  return {
    minX: region.minX - pad,
    minY: region.minY - pad,
    maxX: region.maxX + pad,
    maxY: region.maxY + pad,
  };
}

function cropSvg(svg, region, boxes) {
  let out = String(svg);
  const width = Math.max(1, region.maxX - region.minX);
  const height = Math.max(1, region.maxY - region.minY);
  const viewBox = `${region.minX} ${-region.maxY} ${width} ${height}`;
  if (/viewBox\s*=\s*["'][^"']*["']/i.test(out)) {
    out = out.replace(/viewBox\s*=\s*["'][^"']*["']/i, `viewBox="${viewBox}"`);
  } else {
    out = out.replace(/<svg\b/i, `<svg viewBox="${viewBox}"`);
  }
  out = out.replace(/\swidth\s*=\s*["'][^"']*["']/i, ` width="${Math.min(2000, Math.round(width * 2))}"`);
  out = out.replace(/\sheight\s*=\s*["'][^"']*["']/i, ` height="${Math.min(2000, Math.round(height * 2))}"`);
  const rects = boxes.map(b => {
    const x = b.minX, y = -b.maxY;
    const w = Math.max(0.5, b.maxX - b.minX), h = Math.max(0.5, b.maxY - b.minY);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(220,38,38,0.12)" stroke="#DC2626" stroke-width="2" vector-effect="non-scaling-stroke" data-uid="${escapeXml(b.uid || '')}"/>`;
  }).join('\n');
  out = out.replace(/<\/svg>\s*$/i, `${rects}\n</svg>`);
  return { svg: out, viewBox };
}

export function captureScreenshots(options = {}) {
  const outDir = options.outDir;
  const finalFile = path.join(outDir, 'findings.final.json');
  const data = readJson(finalFile);
  const model = readJson(path.join(outDir, 'model.json'));
  const dir = ensureDir(path.join(outDir, 'screenshots'));
  const failed = [];
  let generated = 0;
  let nonCriticalGenerated = 0;
  let skipped = 0;
  const max = options.maxScreenshots ?? 30;

  for (const finding of data.findings || []) {
    const isP0P1 = ['P0', 'P1'].includes(finding.severity);
    if (!isP0P1 && nonCriticalGenerated >= max) {
      finding.screenshotPlaceholder = '截图数量已达上限';
      skipped++;
      continue;
    }
    const { key, page, mismatch } = choosePage(finding, model);
    if (!page) {
      finding.screenshotPlaceholder = mismatch ? '截图不可用（页/器件不匹配）' : '截图不可用（无几何数据）';
      failed.push({ id: finding.id, reason: mismatch ? 'page/component mismatch' : 'no geometry' });
      continue;
    }
    if (!page.svgPath || !fs.existsSync(path.join(outDir, page.svgPath))) {
      finding.screenshotPlaceholder = '截图不可用（页面 SVG 缺失）';
      failed.push({ id: finding.id, reason: 'no page svg' });
      continue;
    }
    const svgText = fs.readFileSync(path.join(outDir, page.svgPath), 'utf8');
    // Legacy runs collected before page keys carried the schematic dimension
    // may have overwritten page-<name>.svg with another schematic's page.
    // The viewBox recorded at collect time identifies which page the cache
    // actually holds; refuse to crop a foreign page rather than draw wrong boxes.
    const cachedVb = (svgText.match(/<svg\b[^>]*?\bviewBox\s*=\s*["']([^"']*)["']/i) || [])[1];
    const normVb = (s) => String(s).trim().replace(/\s+/g, ' ');
    if (cachedVb && page.svgViewBox && normVb(cachedVb) !== normVb(page.svgViewBox)) {
      finding.screenshotPlaceholder = '截图不可用（页面 SVG 与几何不匹配）';
      failed.push({ id: finding.id, reason: 'page svg viewBox mismatch' });
      continue;
    }
    const uids = collectUids(finding, page, model);
    const boxes = collectBoxes(finding, page, model, uids);
    if (!boxes.length) {
      finding.screenshotPlaceholder = '截图不可用（器件不在当前页）';
      failed.push({ id: finding.id, reason: 'no bbox' });
      continue;
    }
    const region = adjustRegion(finding, page, boxes);
    if (!region) {
      finding.screenshotPlaceholder = '截图不可用（BBox 非法）';
      failed.push({ id: finding.id, reason: 'invalid bbox' });
      continue;
    }
    const cropped = cropSvg(svgText, region, boxes);
    const fileName = `screenshots/${finding.id}.svg`;
    fs.writeFileSync(path.join(outDir, fileName), cropped.svg, 'utf8');
    const labels = uids.map(u => page.components[u]?.designator).filter(Boolean);
    const captionLabel = labels.length ? labels.join('、') : ((finding.location?.nets || [])[0] || '—');
    const label = pageLabelOf(page);
    finding.screenshots = [{
      id: `${finding.id}-shot-1`,
      file: fileName,
      png: null,
      svg: fileName,
      page: label || page.pageName || key,
      caption: `${label ? `${label} · ` : ''}红框为相关器件：${captionLabel}`,
      highlights: labels,
      viewBox: cropped.viewBox,
    }];
    finding.screenshotPlaceholder = null;
    generated++;
    if (!isP0P1) nonCriticalGenerated++;
  }

  data.screenshots = {
    generated,
    failed: failed.length,
    skipped,
    items: failed,
  };
  writeJson(finalFile, data);
  writeJson(path.join(outDir, 'screenshots', 'index.json'), {
    generated, failed, skipped, items: failed,
  });
  return data.screenshots;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法: node capture-screenshots.mjs <runDir> [--max-screenshots 30]');
    process.exit(3);
  }
  const args = process.argv.slice(3);
  const idx = args.indexOf('--max-screenshots');
  try {
    const result = captureScreenshots({ outDir, maxScreenshots: idx >= 0 ? Number(args[idx + 1]) : 30 });
    console.log(`screenshots: ${result.generated} generated, ${result.failed} failed, ${result.skipped} skipped`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
