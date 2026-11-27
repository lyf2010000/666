import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson, writeJson, writeText, escapeHtml, sha256, skillVersion, fileEntry, ensureDir,
  fmtDuration, estimateTokens, numArg, pageLabelOf,
} from './lib/util.mjs';
import { loadMessages, t, localizeFinding } from './lib/i18n.mjs';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function buildPageLabels(model) {
  const labels = new Map();
  for (const page of Object.values(model.geometry?.pages || {})) {
    const label = pageLabelOf(page);
    const name = page?.pageName;
    if (name && !labels.has(name)) labels.set(name, label || name);
    // location.pages now carries unique labels / schematic-dimensioned keys;
    // index those too so duplicate page names across schematics stay distinct.
    if (label && !labels.has(label)) labels.set(label, label);
    const fileKey = page?.pageFileKey;
    if (fileKey && !labels.has(fileKey)) labels.set(fileKey, label || fileKey);
  }
  const current = model.geometry?.currentPage;
  if (current && !labels.has(current)) {
    labels.set(current, model.geometry?.currentSchematic ? `${model.geometry.currentSchematic} / ${current}` : current);
  }
  return labels;
}

function pageDisplayName(name, pageLabels) {
  return pageLabels.get(name) || name;
}

function normalizeTokens(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = numArg(raw.input ?? raw.inputTokens ?? raw.input_tokens, null);
  const output = numArg(raw.output ?? raw.outputTokens ?? raw.output_tokens, null);
  const total = numArg(raw.total ?? raw.totalTokens ?? raw.total_tokens, null);
  if (input == null && output == null && total == null) return null;
  const i = input ?? 0;
  const o = output ?? 0;
  return { input: i, output: o, total: total ?? (i + o) };
}

/** Best-effort token usage when the review session did not record exact counts. */
function estimateTokensUsed(outDir) {
  const progressFile = path.join(outDir, 'progress.json');
  const progress = fs.existsSync(progressFile) ? readJson(progressFile, {}) : {};
  const reviewed = new Set(Object.entries(progress)
    .filter(([, v]) => v && v.status === 'done').map(([k]) => k));
  const packetsManifest = readJson(path.join(outDir, 'packets', 'manifest.json'), {});
  let input = 0;
  if (reviewed.size) {
    for (const packet of packetsManifest.packets || []) {
      if (reviewed.has(packet.fileKey) || reviewed.has(packet.packet_id)) {
        input += Number(packet.estimated_tokens) || 0;
      }
    }
  }
  let output = 0;
  const aiDir = path.join(outDir, 'ai');
  if (fs.existsSync(aiDir)) {
    for (const file of fs.readdirSync(aiDir)) {
      if (!/^findings\.ai\..*\.json$/i.test(file)) continue;
      try { output += estimateTokens(fs.readFileSync(path.join(aiDir, file), 'utf8')); } catch { /* ignore */ }
    }
  }
  if (!input && !output) return null;
  return { input, output, total: input + output };
}

function readReviewMeta(outDir) {
  const manifest = readJson(path.join(outDir, 'manifest.json'), {});
  const context = readJson(path.join(outDir, 'review-context.json'), {});
  const model = context.model || process.env.SCHEMATIC_REVIEW_MODEL || manifest.model || 'unknown';
  const startedAt = context.startedAt || manifest.runAt || null;
  const endedAt = context.endedAt || new Date().toISOString();
  let durationMs = numArg(context.durationMs, null);
  if (durationMs == null && startedAt) {
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durationMs = end - start;
  }
  let tokens = normalizeTokens(context.tokens || context.usage);
  let tokensEstimated = false;
  if (!tokens) {
    tokens = estimateTokensUsed(outDir);
    tokensEstimated = Boolean(tokens);
  }
  return { model, startedAt, endedAt, durationMs, tokens, tokensEstimated };
}

function fmtCount(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

function renderReviewMeta(review, messages) {
  const unknown = t(messages, 'report.meta.unknown');
  const durationText = review.durationMs != null ? fmtDuration(review.durationMs) : unknown;
  const tokensText = review.tokens
    ? `${t(messages, 'report.tokens.input')} ${fmtCount(review.tokens.input)} · ` +
      `${t(messages, 'report.tokens.output')} ${fmtCount(review.tokens.output)} · ` +
      `${t(messages, 'report.tokens.total')} ${fmtCount(review.tokens.total)}` +
      (review.tokensEstimated ? ` (${t(messages, 'report.tokens.estimated')})` : '')
    : unknown;
  return `<div class="review-meta">
      <span><span class="meta-label">${escapeHtml(t(messages, 'report.meta.model'))}</span>${escapeHtml(review.model)}</span>
      <span><span class="meta-label">${escapeHtml(t(messages, 'report.meta.duration'))}</span>${escapeHtml(durationText)}</span>
      <span><span class="meta-label">${escapeHtml(t(messages, 'report.meta.tokens'))}</span>${escapeHtml(tokensText)}</span>
    </div>`;
}

function severityLabel(sev, messages) {
  const key = { P0: 'report.severity.p0', P1: 'report.severity.p1', P2: 'report.severity.p2', P3: 'report.severity.p3' }[sev];
  return key ? t(messages, key) : sev;
}

function evidenceRows(finding) {
  const rows = [];
  for (const e of finding.evidence || []) {
    if (e.kind === 'net') rows.push({ type: 'net', target: e.net || '—', detail: (e.pins || []).join(', ') });
    else if (e.kind === 'pin') rows.push({ type: 'pin', target: `${e.designator || e.uid || ''}.${e.pin || ''}`, detail: `${e.name || ''}${e.net ? ' → ' + e.net : ''}` });
    else if (e.kind === 'component') rows.push({ type: 'component', target: e.designator || e.uid || '—', detail: e.property ? `${e.property}=${e.value ?? ''}` : '' });
    else if (e.kind === 'drc') rows.push({ type: 'drc', target: e.name || '—', detail: `${e.rule || 'DRC'} ${e.primitiveId || ''}` });
    else if (e.kind === 'bom') rows.push({ type: 'bom', target: (e.designators || []).join(', '), detail: e.detail || '' });
    else rows.push({ type: e.kind || 'evidence', target: '—', detail: '' });
  }
  return rows;
}

function renderEvidenceTable(finding, messages) {
  const rows = evidenceRows(finding);
  if (!rows.length) return '';
  return `<table class="evidence"><thead><tr><th>${escapeHtml(t(messages, 'report.evidence'))}</th><th>Type</th><th>Detail</th></tr></thead><tbody>${
    rows.map(r => `<tr><td class="mono" data-copy="${escapeHtml(r.target)}" title="复制">${escapeHtml(r.target)}</td><td>${escapeHtml(r.type)}</td><td class="mono">${escapeHtml(r.detail)}</td></tr>`).join('')
  }</tbody></table>`;
}

function screenshotHtml(finding, { selfContained, outDir, messages }) {
  const shot = (finding.screenshots || [])[0];
  if (!shot?.file) {
    const reason = finding.screenshotPlaceholder ||
      (finding.location?.pages?.length ? t(messages, 'report.screenshot.otherPage') : t(messages, 'report.screenshot.unavailable'));
    return `<div class="placeholder">${escapeHtml(reason)}</div>`;
  }
  const abs = path.join(outDir, shot.file);
  let src = shot.file.split(path.sep).join('/');
  if (selfContained && fs.existsSync(abs)) {
    src = `data:image/svg+xml;base64,${fs.readFileSync(abs).toString('base64')}`;
  }
  return `<figure class="shot">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(finding.title)}" loading="lazy">
    <figcaption>${escapeHtml(shot.caption || '')}</figcaption>
  </figure>`;
}

function renderFinding(f, opts) {
  const { messages, selfContained, outDir, idx, pageLabels } = opts;
  const loc = f.location || {};
  const pages = (loc.pages || []).map(p => pageDisplayName(p, pageLabels)).join(', ');
  const designators = (loc.designators || []).join(', ');
  const nets = (loc.nets || []).join(', ');
  const search = [f.title, f.ruleId, ...(loc.designators || []), ...(loc.nets || []), ...(loc.pages || []), pages].join(' ').toLowerCase();
  const sourceLabel = t(messages, `report.source.${f.source || 'rule'}`);
  const tags = [
    f.ruleId ? `<span class="tag">${escapeHtml(f.ruleId)}</span>` : '',
    f.confidence ? `<span class="tag">confidence: ${escapeHtml(f.confidence)}</span>` : '',
    pages ? `<span class="tag">${escapeHtml(t(messages, 'report.filters.page'))}: ${escapeHtml(pages)}</span>` : '',
  ].filter(Boolean).join('');
  return `<article class="finding" id="${escapeHtml(f.id)}" data-id="${escapeHtml(f.id)}" data-finding-key="${escapeHtml(f.findingKey || f.id)}" data-severity="${escapeHtml(f.severity)}" data-category="${escapeHtml(f.category || '')}" data-page="${escapeHtml((loc.pages || [])[0] || '')}" data-search="${escapeHtml(search)}" data-index="${idx}">
    <div class="finding-head">
      <span class="badge ${escapeHtml(String(f.severity).toLowerCase())}">${escapeHtml(f.severity)} · ${escapeHtml(severityLabel(f.severity, messages))}</span>
      <span class="badge source">${escapeHtml(sourceLabel)}</span>
      <h3 class="finding-title">${escapeHtml(f.title)}</h3>
      <span class="finding-id">${escapeHtml(f.id)}</span>
    </div>
    <div class="finding-body">
      <div class="finding-main">
        <p><span class="label">${escapeHtml(t(messages, 'report.observation'))}</span><br>${escapeHtml(f.observation || '')}</p>
        <p><span class="label">${escapeHtml(t(messages, 'report.impact'))}</span><br>${escapeHtml(f.impact || '')}</p>
        <p><span class="label">${escapeHtml(t(messages, 'report.suggestion'))}</span><br>${escapeHtml(f.suggestion || '')}</p>
        ${(() => {
          const enh = Array.isArray(f.aiEnhancements) && f.aiEnhancements.length
            ? f.aiEnhancements
            : (f.aiEnhancement ? [f.aiEnhancement] : []);
          return enh.map(e => `<p><span class="label">AI</span><br>${escapeHtml(e.observation || '')}${e.impact ? `<br>${escapeHtml(e.impact)}` : ''}<br><span class="note">${escapeHtml(e.suggestion || '')}</span></p>`).join('');
        })()}
        ${renderEvidenceTable(f, messages)}
        <div class="tags">${tags}</div>
      </div>
      <div>
        ${screenshotHtml(f, { selfContained, outDir, messages })}
        ${pages || designators || nets ? `<p class="note">${escapeHtml(t(messages, 'report.location'))}: ${escapeHtml([pages, designators, nets].filter(Boolean).join(' / '))}</p>` : ''}
      </div>
    </div>
    <div class="review-box">
      <span class="review-state">review</span>
      <button class="chip review-state-btn" data-status="pending" aria-pressed="true">${escapeHtml(t(messages, 'report.review.status.pending'))}</button>
      <button class="chip review-state-btn" data-status="confirmed" aria-pressed="false">${escapeHtml(t(messages, 'report.review.status.confirmed'))}</button>
      <button class="chip review-state-btn" data-status="waived" aria-pressed="false">${escapeHtml(t(messages, 'report.review.status.waived'))}</button>
      <textarea class="review-note" placeholder="备注…"></textarea>
    </div>
  </article>`;
}

function renderTop3(findings, model, messages, pageLabels) {
  const top = findings.filter(f => ['P0', 'P1'].includes(f.severity)).slice(0, 3);
  if (!top.length) {
    return `<div class="top3"><div class="top-card empty"><span class="rank">Top 3</span><h3>${escapeHtml(t(messages, 'report.top3.empty'))}</h3><p class="note">${escapeHtml(t(messages, 'report.empty.hint'))}</p></div></div>`;
  }
  return `<div class="top3">${top.map((f, i) => {
    const pages = (f.location?.pages || []).map(p => pageDisplayName(p, pageLabels));
    return `
    <div class="top-card" data-jump="${escapeHtml(f.id)}">
      <span class="rank">#${i + 1} · ${escapeHtml(f.severity)}</span>
      <h3>${escapeHtml(f.title)}</h3>
      <p class="note">${escapeHtml([...pages, ...(f.location?.designators || []), ...(f.location?.nets || [])].join(' / '))}</p>
    </div>`;
  }).join('')}</div>`;
}

function renderCoverage(data, messages) {
  const c = data.coverage || {};
  const partial = c.partial ? `<div class="partial">${escapeHtml(t(messages, 'report.partial', { reason: c.partialReason || 'AI 包未全部完成' }))}</div>` : '';
  const scope = c.scope ? `<div class="note">${escapeHtml(t(messages, 'report.scope'))}: ${escapeHtml(c.scope)}</div>` : '';
  const omittedDetail = Object.entries(c.omittedByRule || {}).map(([k, n]) => `${k}: ${n}`).join(', ');
  const omitted = c.omittedFindings ? `<div class="note">${escapeHtml(t(messages, 'report.omitted', { count: c.omittedFindings, detail: omittedDetail || '—' }))}</div>` : '';
  return `${partial}<div class="coverage">
    <div class="metric"><div class="label">${escapeHtml(t(messages, 'report.coverage.components', { percent: pct(c.componentPercent) }))}</div><div class="value">${pct(c.componentPercent)}</div><div class="meter"><span style="width:${Math.round((c.componentPercent || 0) * 100)}%"></span></div></div>
    <div class="metric"><div class="label">${escapeHtml(t(messages, 'report.coverage.nets', { percent: pct(c.netPercent) }))}</div><div class="value">${pct(c.netPercent)}</div><div class="meter"><span style="width:${Math.round((c.netPercent || 0) * 100)}%"></span></div></div>
    <div class="metric"><div class="label">Packets reviewed</div><div class="value">${(c.packetsReviewed || []).length}</div><div class="note">${escapeHtml((c.packetsFailed || []).length ? `failed: ${c.packetsFailed.length}` : '')}</div></div>
    <div class="metric"><div class="label">Suppressed</div><div class="value">${c.suppressedFindings || 0}</div><div class="note">${escapeHtml((c.skippedRules || []).map(r => r.ruleId).join(', '))}</div></div>
  </div>${omitted}${scope}`;
}

function renderQuestions(questions, messages) {
  if (!questions.length) return `<div class="section questions"><h2>${escapeHtml(t(messages, 'report.questions'))}</h2><p class="note">—</p></div>`;
  return `<div class="section questions"><h2>${escapeHtml(t(messages, 'report.questions'))}</h2><ul>${
    questions.map(q => `<li><strong>${escapeHtml(q.question)}</strong>${q.why ? `<br><span class="note">${escapeHtml(q.why)}</span>` : ''}</li>`).join('')
  }</ul></div>`;
}

function renderRiskTable(findings, messages) {
  const cats = new Map();
  for (const f of findings) {
    const key = f.category || 'other';
    if (!cats.has(key)) cats.set(key, { P0: 0, P1: 0, P2: 0, P3: 0 });
    cats.get(key)[f.severity] = (cats.get(key)[f.severity] || 0) + 1;
  }
  if (!cats.size) return '';
  const rows = [...cats.entries()].sort((a, b) => (b[1].P0 + b[1].P1) - (a[1].P0 + a[1].P1) || a[0].localeCompare(b[0]));
  const title = t(messages, 'report.filters.category') === 'Category' ? 'Risk by category' : '类别 × 级别统计';
  return `<div class="section"><h2>${escapeHtml(title)}</h2><table class="evidence"><thead><tr><th>${escapeHtml(t(messages, 'report.filters.category'))}</th><th>P0</th><th>P1</th><th>P2</th><th>P3</th></tr></thead><tbody>${
    rows.map(([cat, c]) => `<tr><td>${escapeHtml(cat)}</td><td>${c.P0}</td><td>${c.P1}</td><td>${c.P2}</td><td>${c.P3}</td></tr>`).join('')
  }</tbody></table></div>`;
}

function renderAppendix(data, model, messages) {
  const skipped = data.coverage?.skippedRules || [];
  const drc = model.drc || [];
  const comps = model.components || [];
  const nets = model.nets || [];
  return `<div class="section appendix"><h2>${escapeHtml(t(messages, 'report.appendix'))}</h2>
    <details><summary>${escapeHtml(t(messages, 'report.coverage'))} · ${comps.length} components / ${nets.length} nets</summary>
      <p class="note">${escapeHtml(model.source?.project || '')} / ${escapeHtml(model.source?.board || '')} / ${escapeHtml(model.source?.schematic || '')}</p>
      <table class="evidence"><thead><tr><th>Rule</th><th>Reason</th></tr></thead><tbody>${skipped.map(s => `<tr><td>${escapeHtml(s.ruleId)}</td><td>${escapeHtml(s.reason)}</td></tr>`).join('')}</tbody></table>
    </details>
    <details><summary>DRC (${drc.length})</summary><pre class="mono">${escapeHtml(JSON.stringify(drc, null, 2)).slice(0, 20000)}</pre></details>
  </div>`;
}

export function renderReport(options = {}) {
  const outDir = options.outDir;
  const lang = options.lang || 'zh';
  const messages = loadMessages(lang);
  const data = readJson(path.join(outDir, 'findings.final.json'));
  const model = readJson(path.join(outDir, 'model.json'));
  data.findings = (data.findings || []).map(f => f.source === 'rule' ? localizeFinding(f, lang, messages) : f);
  const selfContained = Boolean(options.selfContained);
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of data.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const css = fs.readFileSync(path.join(ASSETS, 'report.css'), 'utf8');
  const js = fs.readFileSync(path.join(ASSETS, 'report.js'), 'utf8');
  const date = new Date(data.generatedAt || Date.now()).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN');
  const categories = [...new Set(data.findings.map(f => f.category).filter(Boolean))].sort();
  const pageLabels = buildPageLabels(model);
  const pageOptions = [...new Set(data.findings.flatMap(f => f.location?.pages || []))]
    .map(raw => ({ raw, label: pageDisplayName(raw, pageLabels) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const review = readReviewMeta(outDir);
  const findingsHtml = data.findings.length
    ? data.findings.map((f, i) => renderFinding(f, { messages, selfContained, outDir, idx: i, pageLabels })).join('\n')
    : `<div class="placeholder">${escapeHtml(t(messages, 'report.empty'))}<br><span class="note">${escapeHtml(t(messages, 'report.empty.hint'))}</span></div>`;
  const embedded = {
    runId: data.runId,
    skillVersion: data.skillVersion,
    lang,
    findings: data.findings.map(f => ({ id: f.id, findingKey: f.findingKey, severity: f.severity, category: f.category, title: f.title })),
  };
  const html = `<!DOCTYPE html>
<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t(messages, 'report.title'))} · ${escapeHtml(data.runId || '')}</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <header class="report-header">
    <div class="title-block">
      <h1>${escapeHtml(t(messages, 'report.title'))}</h1>
      <p class="subtitle">${escapeHtml(t(messages, 'report.subtitle', {
        project: model.source?.project || '—',
        board: model.source?.board || '—',
        schematic: model.source?.schematic || '—',
        date,
      }))}</p>
      ${renderReviewMeta(review, messages)}
      <p class="disclaimer">${escapeHtml(t(messages, 'report.disclaimer'))}</p>
    </div>
    <div class="severity-summary">
      <div class="severity-card p0">P0<strong>${counts.P0 || 0}</strong></div>
      <div class="severity-card p1">P1<strong>${counts.P1 || 0}</strong></div>
      <div class="severity-card p2">P2<strong>${counts.P2 || 0}</strong></div>
      <div class="severity-card p3">P3<strong>${counts.P3 || 0}</strong></div>
      <div class="severity-card open">${escapeHtml(t(messages, 'report.severity.open'))}<strong>${(data.openQuestions || []).length}</strong></div>
    </div>
  </header>

  <div class="section"><h2>${escapeHtml(t(messages, 'report.top3'))}</h2>${renderTop3(data.findings, model, messages, pageLabels)}</div>
  <div class="section"><h2>${escapeHtml(t(messages, 'report.coverage'))}</h2>${renderCoverage(data, messages)}</div>
  ${renderRiskTable(data.findings, messages)}

  <div class="toolbar">
    <button class="chip severity-chip" data-severity="all" aria-pressed="true">${escapeHtml(t(messages, 'report.filters.all'))}</button>
    <button class="chip severity-chip" data-severity="P0" aria-pressed="false">P0</button>
    <button class="chip severity-chip" data-severity="P1" aria-pressed="false">P1</button>
    <button class="chip severity-chip" data-severity="P2" aria-pressed="false">P2</button>
    <button class="chip severity-chip" data-severity="P3" aria-pressed="false">P3</button>
    <select id="filter-category" class="select"><option value="all">${escapeHtml(t(messages, 'report.filters.category'))}</option>${categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
    <select id="filter-page" class="select"><option value="all">${escapeHtml(t(messages, 'report.filters.page'))}</option>${pageOptions.map(p => `<option value="${escapeHtml(p.raw)}">${escapeHtml(p.label)}</option>`).join('')}</select>
    <input id="search" type="search" placeholder="${escapeHtml(t(messages, 'report.search.placeholder'))}">
    <button id="export-minutes" class="btn">${escapeHtml(t(messages, 'report.review.export'))}</button>
    <span class="note"><strong id="visible-count">${data.findings.length}</strong> / ${data.findings.length}</span>
  </div>
  <div id="storage-hint" class="partial" hidden>${escapeHtml(t(messages, 'report.review.localStorageFailed'))}</div>
  <div id="filter-empty" class="placeholder" hidden>${escapeHtml(t(messages, 'report.empty'))}</div>

  <section class="section"><h2>${escapeHtml(t(messages, 'report.findings'))}</h2>${findingsHtml}</section>
  ${renderQuestions(data.openQuestions || [], messages)}
  ${renderAppendix(data, model, messages)}
  <footer class="report-footer">${escapeHtml(t(messages, 'report.footer', {
    version: data.skillVersion || skillVersion(),
    runId: data.runId || '',
    ruleVersion: '1.0',
    model: review.model,
  }))}</footer>
</div>
<div id="lightbox" class="lightbox" hidden><button class="lightbox-close" aria-label="close">×</button><img id="lightbox-img" alt=""></div>
<div id="toast" class="toast"></div>
<script>window.__REPORT__ = ${JSON.stringify(embedded).replace(/</g, '\\u003c')};</script>
<script>${js}</script>
</body>
</html>`;
  const htmlFile = path.join(outDir, 'report.html');
  writeText(htmlFile, html);

  const artifacts = [
    fileEntry(outDir, 'report.html', 'report'),
    fileEntry(outDir, 'model.json', 'model'),
    fileEntry(outDir, 'lint.json', 'lint'),
    fileEntry(outDir, 'findings.final.json', 'other'),
    fileEntry(outDir, 'manifest.json', 'other'),
    ...(fs.existsSync(path.join(outDir, 'screenshots'))
      ? fs.readdirSync(path.join(outDir, 'screenshots')).filter(f => f.endsWith('.svg')).sort()
        .map(f => fileEntry(outDir, path.join('screenshots', f), 'screenshot'))
      : []),
  ].filter(Boolean);

  const reportJson = {
    schemaVersion: '1.0',
    runId: data.runId,
    skillVersion: data.skillVersion || skillVersion(),
    generatedAt: new Date().toISOString(),
    lang,
    mode: data.mode,
    source: data.source,
    stats: data.stats,
    findings: data.findings,
    openQuestions: data.openQuestions || [],
    coverage: data.coverage,
    review,
    screenshots: data.screenshots || { generated: 0, failed: 0, skipped: 0 },
    artifacts,
  };
  writeJson(path.join(outDir, 'report.json'), reportJson);
  return { htmlFile, reportJson };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('用法: node render-html.mjs <runDir> [--lang zh|en] [--self-contained]');
    process.exit(3);
  }
  const args = process.argv.slice(3);
  const li = args.indexOf('--lang');
  try {
    const r = renderReport({
      outDir,
      lang: li >= 0 ? args[li + 1] : 'zh',
      selfContained: args.includes('--self-contained'),
    });
    console.log(`report written: ${r.htmlFile}`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
