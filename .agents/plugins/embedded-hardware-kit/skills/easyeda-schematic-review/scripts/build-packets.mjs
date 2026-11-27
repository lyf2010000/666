import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, ensureDir, sanitizeFileKey, estimateTokens } from './lib/util.mjs';

const PASSIVE = new Set(['resistor', 'resistor_array', 'capacitor', 'inductor', 'ferrite', 'diode', 'led', 'crystal']);
const COMPONENT_PACKET_CATEGORIES = new Set([
  'ic', 'regulator', 'connector', 'crystal', 'optocoupler', 'mosfet', 'transistor',
  'fuse', 'tvs', 'relay', 'power_source', 'switch',
]);

function slimComponent(c) {
  return {
    uid: c.uid,
    designator: c.designator,
    page: c.page || null,
    category: c.category,
    categoryConfidence: c.categoryConfidence,
    categoryBasis: c.categoryBasis,
    value: c.rawValue ?? c.displayValue,
    footprint: c.footprint,
    supplierPart: c.supplierPart,
    description: c.description,
    addIntoBom: c.addIntoBom,
    convertToPcb: c.convertToPcb,
    dnp: c.dnp,
    pins: c.pins.filter(p => p.net || p.name).map(p => ({ number: p.number, name: p.name, net: p.net })),
  };
}

function slimNet(n) {
  return {
    name: n.name,
    pinCount: n.pinCount,
    isPower: n.isPower,
    isGround: n.isGround,
    powerKind: n.powerKind,
    pins: n.pins.map(p => `${p.designator}.${p.pin}`),
  };
}

function relatedFindings(lint, uids, nets, designators) {
  return (lint?.findings || []).filter(f => {
    const fu = f.location?.uids || [];
    const fn = f.location?.nets || [];
    const fd = f.location?.designators || [];
    return fu.some(u => uids.has(u)) || fn.some(n => nets.has(n)) || fd.some(d => designators.has(d));
  }).map(f => ({
    id: f.id || null,
    findingKey: f.findingKey || null,
    ruleId: f.ruleId,
    severity: f.severity,
    messageKey: f.messageKey,
    params: f.params,
    evidence: f.evidence,
  }));
}

function relatedQuestions(lint, uids, nets, designators) {
  const refs = new Set([...uids, ...nets, ...designators]);
  return (lint?.openQuestions || []).filter(q =>
    (q.related || []).some(r => refs.has(r) || [...refs].some(x => String(r).includes(x))),
  ).map(q => q.question);
}

const CHECKLIST_BY_CATEGORY = {
  ic: ["C-MCU", "C-RST", "C-IF", "C-PWR", "C-LVL"],
  regulator: ["C-PWR", "C-PRT", "C-ANA", "C-LVL"],
  connector: ["C-CON", "C-PRT", "C-LVL", "C-GND"],
  crystal: ["C-RST", "C-PAS"],
  mosfet: ["C-DIS", "C-PRT"],
  transistor: ["C-DIS"],
  diode: ["C-DIS"],
  led: ["C-IND", "C-DIS"],
  relay: ["C-IND", "C-PRT"],
  optocoupler: ["C-LVL", "C-IF"],
  fuse: ["C-PRT"],
  tvs: ["C-PRT"],
  power_source: ["C-PWR", "C-PRT", "C-SAF"],
  switch: ["C-CON", "C-LVL"],
  capacitor: ["C-PAS", "C-PWR"],
  resistor: ["C-PAS"],
  resistor_array: ["C-PAS"],
  inductor: ["C-PAS", "C-PWR"],
  ferrite: ["C-PAS", "C-PWR"],
};

function checklistFor(id, components) {
  if (id === "power") return ["C-PWR", "C-PRT", "C-GND", "C-SAF"];
  if (id === "passives") return ["C-PAS", "C-DIS", "C-IND"];
  if (id.startsWith("interface:")) return ["C-IF", "C-LVL", "C-CON"];
  const cats = [...new Set(components.map(c => c.category))];
  return [...new Set(cats.flatMap(c => CHECKLIST_BY_CATEGORY[c] || ["C-BOM"]))];
}

function makePacket(id, tier, subject, components, nets, lint, extraQuestions = [], limits = {}) {
  const neighborLimit = limits.neighborLimit ?? 20;
  const questionLimit = limits.questionLimit ?? 10;
  const uids = new Set(components.map(c => c.uid));
  const designators = new Set(components.map(c => c.designator));
  const netNames = new Set(nets.map(n => n.name));
  const neighbors = [];
  for (const c of components) {
    for (const p of c.pins) {
      if (p.net && !netNames.has(p.net)) {
        const n = nets.find(x => x.name === p.net);
        if (n) neighbors.push(slimNet(n));
      }
    }
  }
  const facts = {
    components: components.map(slimComponent),
    nets: nets.map(slimNet),
  };
  const checklistDomains = checklistFor(id, components);
  const packet = {
    packet_id: id,
    fileKey: sanitizeFileKey(id),
    tier,
    subject,
    facts,
    neighbors: dedupeBy(neighbors, n => n.name).slice(0, neighborLimit),
    existingRuleFindings: relatedFindings(lint, uids, netNames, designators),
    questions: [...new Set([...relatedQuestions(lint, uids, netNames, designators), ...extraQuestions])].slice(0, questionLimit),
    checklist: { domains: checklistDomains, file: "references/review-checklist.md" },
    estimated_tokens: 0,
  };
  packet.estimated_tokens = estimateTokens(JSON.stringify(packet));
  return packet;
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

function interfacePackets(model, lint, limits = {}) {
  const packets = [];
  const patterns = [
    { id: 'interface:I2C', subject: 'I2C 总线', re: /(^|[_-])(SCL|SDA)([_-]|\d*$)/i },
    { id: 'interface:SPI', subject: 'SPI 总线', re: /(^|[_-])(SCK|MISO|MOSI|CS|SS)([_-]|\d*$)/i },
    { id: 'interface:UART', subject: 'UART 接口', re: /(^|[_-])(TX|RX|TXD|RXD|UART)([_-]|\d*$)/i },
    { id: 'interface:USB', subject: 'USB 接口', re: /(^|[_-])(D\+|D-|DP|DM|VBUS|USB)([_-]|\d*$)/i },
    { id: 'interface:RESET', subject: '复位/启动', re: /RESET|NRST|RST|BOOT/i },
  ];
  for (const pat of patterns) {
    const nets = model.nets.filter(n => pat.re.test(n.name));
    if (!nets.length) continue;
    const uids = new Set(nets.flatMap(n => n.pins.map(p => p.uid)));
    const comps = model.components.filter(c => uids.has(c.uid));
    packets.push(makePacket(pat.id, 'T1', pat.subject, comps, nets, lint, [], limits));
  }
  return packets;
}

export function buildPackets(model, lint, options = {}) {
  const maxPackets = options.maxPackets ?? 20;
  const limits = { neighborLimit: options.neighborLimit, questionLimit: options.questionLimit };
  const packets = [];

  const powerNets = model.nets.filter(n => n.isPower || n.isGround);
  const powerUids = new Set(powerNets.flatMap(n => n.pins.map(p => p.uid)));
  const powerComps = model.components.filter(c => powerUids.has(c.uid));
  packets.push(makePacket('power', 'T0', '电源与地网络', powerComps, powerNets, lint, [], limits));

  for (const c of model.components) {
    if (!COMPONENT_PACKET_CATEGORIES.has(c.category)) continue;
    if (c.category === 'connector' && c.pins.length > 20) continue;
    const nets = model.nets.filter(n => c.pins.some(p => p.net === n.name));
    packets.push(makePacket(`component:${c.designator || c.uid}`, 'T1', `${c.designator} ${c.category}`, [c], nets, lint, [], limits));
  }

  packets.push(...interfacePackets(model, lint, limits));

  const covered = new Set(packets.flatMap(p => p.facts.components.map(c => c.uid)));
  const rest = model.components.filter(c => !covered.has(c.uid));
  if (rest.length) {
    packets.push(makePacket('passives', 'T2', '其余无源/辅助器件', rest, [], lint, [], limits));
  }

  const tokenLimit = options.packetTokenLimit ?? 6000;
  const byUid = new Map(model.components.map(c => [c.uid, c]));
  const byNet = new Map(model.nets.map(n => [n.name, n]));
  const splitPackets = [];
  for (const p of packets) {
    if (p.estimated_tokens <= tokenLimit) { splitPackets.push(p); continue; }
    const uids = p.facts.components.map(c => c.uid).filter(uid => byUid.has(uid));
    const nets = p.facts.nets.map(n => byNet.get(n.name)).filter(Boolean);
    const parts = Math.max(1, Math.ceil(p.estimated_tokens / tokenLimit));
    const chunkSize = Math.max(1, Math.ceil(uids.length / parts));
    for (let i = 0; i < uids.length; i += chunkSize) {
      const partNo = Math.floor(i / chunkSize) + 1;
      const comps = uids.slice(i, i + chunkSize).map(uid => byUid.get(uid));
      splitPackets.push(makePacket(p.packet_id + '~' + partNo, p.tier, p.subject + ' #' + partNo, comps, nets, lint, [], limits));
    }
  }
  const unique = dedupeBy(splitPackets, p => p.fileKey);
  unique.sort((a, b) => {
    const focus = String(options.focus || '').toLowerCase();
    const aHit = focus && (a.subject.toLowerCase().includes(focus) || a.facts.components.some(c => String(c.designator).toLowerCase() === focus));
    const bHit = focus && (b.subject.toLowerCase().includes(focus) || b.facts.components.some(c => String(c.designator).toLowerCase() === focus));
    if (aHit !== bHit) return aHit ? -1 : 1;
    const t = { T0: 0, T1: 1, T2: 2 };
    if (t[a.tier] !== t[b.tier]) return t[a.tier] - t[b.tier];
    return b.estimated_tokens - a.estimated_tokens;
  });
  return unique.slice(0, maxPackets);
}

export function writePackets(outDir, packets, options = {}) {
  const dir = path.join(outDir, 'packets');
  ensureDir(dir);
  for (const p of packets) writeJson(path.join(dir, `${p.fileKey}.json`), p);
  const manifest = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    focus: options.focus || null,
    count: packets.length,
    packets: packets.map(p => ({
      packet_id: p.packet_id,
      fileKey: p.fileKey,
      tier: p.tier,
      subject: p.subject,
      estimated_tokens: p.estimated_tokens,
      findingCount: p.existingRuleFindings.length,
      questionCount: p.questions.length,
      checklistDomains: p.checklist?.domains || [],
    })),
  };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

export function packetsForModel(modelFile, lintFile, outDir, options = {}) {
  const model = readJson(modelFile);
  const lint = lintFile && fs.existsSync(lintFile) ? readJson(lintFile) : { findings: [], openQuestions: [] };
  const packets = buildPackets(model, lint, options);
  return { packets, manifest: writePackets(outDir, packets) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [modelFile, lintFile, outDir] = process.argv.slice(2);
  if (!modelFile || !outDir) {
    console.error('用法: node build-packets.mjs <model.json> <lint.json|-> <outDir>');
    process.exit(3);
  }
  try {
    const { manifest } = packetsForModel(modelFile, lintFile === '-' ? null : lintFile, outDir);
    console.log(`packets written: ${manifest.count}`);
    for (const p of manifest.packets) console.log(`- ${p.fileKey} (${p.tier}, ~${p.estimated_tokens} tokens)`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
