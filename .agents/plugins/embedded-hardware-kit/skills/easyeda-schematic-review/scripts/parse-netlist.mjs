import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson, writeJson, ensureDir, sha256, sanitizeFileKey, createLogger, pageLabelOf,
} from './lib/util.mjs';
import {
  classifyComponent, classifyNet, dnpInfo, boolProp, isPlaceholderValue,
} from './lib/classify-components.mjs';

function text(v) { return v == null ? '' : String(v); }

function resolveExpr(value, props) {
  if (typeof value !== 'string') return value == null ? '' : String(value);
  const m = value.match(/^=\{([^}]+)\}$/);
  if (!m) return value;
  const key = m[1].trim();
  return props[key] != null ? String(props[key]) : '';
}

function normalizePinMap(rawPins) {
  const out = [];
  if (Array.isArray(rawPins)) {
    for (const p of rawPins) {
      out.push({
        number: text(p.number ?? p.pinNumber ?? p.num),
        name: text(p.name ?? p.pinName),
        net: text(p.net ?? p.netName),
        pinClass: text(p.pinClass),
        differentialPairClass: text(p.pinDifferentialPairClass),
        pinType: text(p.pinType ?? p.type),
        noConnect: p.noConnect === true || p.noConnected === true,
        props: p.props || {},
      });
    }
    return out;
  }
  if (rawPins && typeof rawPins === 'object') {
    for (const [key, p] of Object.entries(rawPins)) {
      out.push({
        number: text(p.number ?? p.pinNumber ?? key),
        name: text(p.name ?? p.pinName),
        net: text(p.net ?? p.netName),
        pinClass: text(p.pinClass),
        differentialPairClass: text(p.pinDifferentialPairClass),
        pinType: text(p.pinType ?? p.type),
        noConnect: p.noConnect === true || p.noConnected === true,
        props: p.props || {},
      });
    }
  }
  return out;
}

function readPinsFile(file) {
  if (!file || !fs.existsSync(file)) return { byUid: new Map(), available: false };
  const data = readJson(file, null);
  const byUid = new Map();
  const arr = Array.isArray(data) ? data : (data?.components || data?.pins || []);
  for (const c of arr) {
    const uid = text(c.uid ?? c.uniqueId ?? c.id);
    if (!uid) continue;
    const pins = Array.isArray(c.pins) ? c.pins : [];
    byUid.set(uid, pins);
  }
  return { byUid, available: byUid.size > 0 };
}

function normalizeGeometry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.pages && typeof raw.pages === 'object') return raw;
  const pageKey = raw.pageKey || raw.pageName || '__current__';
  return {
    currentPage: raw.currentPage || raw.pageName || null,
    currentSchematic: raw.currentSchematic || raw.schematicName || null,
    pages: {
      [pageKey]: {
        pageUuid: raw.pageUuid || null,
        pageName: raw.pageName || null,
        pageFileKey: raw.pageFileKey || sanitizeFileKey(raw.pageName || pageKey),
        schematicUuid: raw.schematicUuid || null,
        schematicName: raw.schematicName || raw.currentSchematic || null,
        pageWidth: raw.pageWidth ?? null,
        pageHeight: raw.pageHeight ?? null,
        svgViewBox: raw.svgViewBox || null,
        svgPath: raw.svgPath || null,
        pngPath: raw.pngPath || null,
        components: raw.components || {},
        designatorIndex: raw.designatorIndex || {},
        drcPrimitives: raw.drcPrimitives || {},
      },
    },
  };
}

export function buildModel(netlist, options = {}) {
  const { pinsFile, drc = [], geometry = null, source = {}, warnings = [] } = options;
  const log = options.logger || createLogger();
  if (!netlist || typeof netlist !== 'object') throw new Error('网表 JSON 为空或格式不支持');
  const rawComponents = netlist.components;
  if (!rawComponents || typeof rawComponents !== 'object') throw new Error('网表缺少 components 字段');

  const pinsFileData = readPinsFile(pinsFile);
  const pinsAvailable = pinsFileData.available;
  const components = [];
  let entries = Array.isArray(rawComponents)
    ? rawComponents.map(c => [text(c.uid ?? c['Unique ID']), c])
    : Object.entries(rawComponents);

  for (const [key, raw] of entries) {
    const props = raw?.props || raw?.properties || {};
    const uid = text(props['Unique ID'] ?? raw?.uid ?? key);
    if (!uid) continue;
    const designator = text(props.Designator ?? raw?.designator);
    const rawValue = props.Value != null ? String(props.Value) : (raw?.value != null ? String(raw.value) : null);
    const displayValue = rawValue && rawValue.trim()
      ? rawValue
      : text(props['LCSC Part Name'] || props['Manufacturer Part'] || resolveExpr(props.Name, props) || props.DeviceName || props.Device || '');
    const pinList = normalizePinMap(raw.pinInfoMap ?? raw.pins ?? raw.pinInfo);
    const livePins = pinsFileData.byUid.get(uid) || [];
    const liveByNumber = new Map(livePins.map(p => [text(p.number ?? p.pinNumber ?? p.num), p]));
    const pins = pinList.map(p => {
      const live = liveByNumber.get(p.number);
      return {
        number: p.number,
        name: p.name,
        net: p.net,
        pinClass: p.pinClass,
        differentialPairClass: p.differentialPairClass,
        pinType: text(live?.pinType ?? p.pinType ?? ''),
        noConnect: Boolean(live?.noConnect ?? live?.noConnected ?? p.noConnect),
        props: p.props,
      };
    });
    // pins.json may contain pins absent from the netlist (rare); add them as unconnected.
    for (const lp of livePins) {
      const num = text(lp.number ?? lp.pinNumber ?? lp.num);
      if (!num || pins.some(p => p.number === num)) continue;
      pins.push({
        number: num, name: text(lp.name ?? lp.pinName), net: '', pinClass: '',
        differentialPairClass: '', pinType: text(lp.pinType ?? ''), noConnect: Boolean(lp.noConnect ?? lp.noConnected), props: {},
      });
    }

    const comp = {
      uid,
      designator,
      name: text(resolveExpr(props.Name, props) || props.DeviceName || props['LCSC Part Name'] || displayValue),
      displayValue,
      rawValue,
      valuePlaceholder: isPlaceholderValue(rawValue),
      footprint: text(props.Footprint || props.FootprintName || ''),
      supplierPart: text(props['Supplier Part'] || ''),
      manufacturer: text(props.Manufacturer || ''),
      manufacturerPart: text(props['Manufacturer Part'] || ''),
      lcscPartName: text(props['LCSC Part Name'] || ''),
      partClass: text(props['JLCPCB Part Class'] || ''),
      datasheet: text(props.Datasheet || ''),
      description: text(props.Description || ''),
      addIntoBom: boolProp(props['Add into BOM'], true),
      convertToPcb: boolProp(props['Convert to PCB'], true),
      page: null,
      pins,
      props,
      groupId: text(props['Group ID'] || ''),
      device: text(props.Device || ''),
      deviceName: text(props.DeviceName || ''),
      channelId: text(props['Channel ID'] || ''),
    };
    const dnp = dnpInfo(props);
    Object.assign(comp, { dnp: dnp.dnp, dnpConfidence: dnp.dnpConfidence, dnpSource: dnp.dnpSource, dnpCandidate: dnp.dnpCandidate });
    const cls = classifyComponent(comp);
    comp.category = cls.category;
    comp.categoryConfidence = cls.categoryConfidence;
    comp.categoryBasis = cls.categoryBasis;
    comp.pinsAvailable = pinsAvailable;
    components.push(comp);
  }

  // 属性缺失时按普通器件（加入 BOM/PCB）处理，避免 R016/R017/R019 被整体静默跳过。
  const missingFlags = components.filter(c =>
    c.props['Add into BOM'] == null && c.props['Convert to PCB'] == null).length;
  if (missingFlags) {
    warnings.push(`${missingFlags} 个器件缺少 Add into BOM/Convert to PCB 属性，已按 yes 处理`);
  }

  // Page mapping from geometry: uid -> unique "schematic / page" label + page key.
  // A bare pageName ("P1") is ambiguous across schematics; the label and the
  // schematic-dimensioned pageFileKey are what packets/findings must carry.
  // EasyEDA primitive uids are page-local: the same uid can appear on several
  // pages as different parts, so only claim a component when the geometry
  // designator agrees with the netlist.
  const geo = normalizeGeometry(geometry);
  if (geo) {
    const byUid = new Map(components.map(c => [c.uid, c]));
    for (const [pageKey, page] of Object.entries(geo.pages)) {
      const label = pageLabelOf(page) || page.pageName || pageKey;
      const fileKey = page.pageFileKey || pageKey;
      for (const [uid, geoComp] of Object.entries(page.components || {})) {
        const comp = byUid.get(uid);
        if (!comp) continue;
        const gd = geoComp?.designator;
        if (gd && comp.designator && gd !== comp.designator) continue;
        comp.page = label;
        comp.pageKey = fileKey;
      }
    }
  }

  // Nets
  const netMap = new Map();
  const ensureNet = (name) => {
    if (!netMap.has(name)) {
      netMap.set(name, { name, pinCount: 0, pins: [] });
    }
    return netMap.get(name);
  };
  for (const comp of components) {
    for (const pin of comp.pins) {
      if (!pin.net) continue;
      const net = ensureNet(pin.net);
      net.pins.push({ uid: comp.uid, designator: comp.designator, pin: pin.number, pinName: pin.name });
      net.pinCount++;
    }
  }
  // Nets declared by design rules but with no pins still matter for R004.
  const designRules = netlist.designRule?.netRule;
  if (designRules && typeof designRules === 'object') {
    for (const name of Object.keys(designRules)) ensureNet(name);
  }
  const nets = [...netMap.values()].sort((a, b) => a.name.localeCompare(b.name)).map(net => {
    const cls = classifyNet(net.name);
    return {
      ...net,
      isAuto: net.name.startsWith('$'),
      isPower: cls.isPower,
      isGround: cls.isGround,
      powerKind: cls.powerKind,
      netClassConfidence: cls.netClassConfidence,
      netClassBasis: cls.netClassBasis,
    };
  });

  const duplicateDesignators = new Map();
  for (const c of components) {
    if (!c.designator) continue;
    if (!duplicateDesignators.has(c.designator)) duplicateDesignators.set(c.designator, []);
    duplicateDesignators.get(c.designator).push(c.uid);
  }
  for (const [designator, uids] of duplicateDesignators) {
    if (uids.length > 1) warnings.push(`重复位号 ${designator}: ${uids.join(', ')}`);
  }

  return {
    schemaVersion: '1.0',
    source: {
      mode: source.mode || 'file',
      project: source.project || null,
      board: source.board || null,
      schematic: source.schematic || null,
      netlistType: source.netlistType || 'JLCEDA',
      netlistVersion: text(netlist.version || source.netlistVersion || ''),
      exportedAt: source.exportedAt || new Date().toISOString(),
    },
    stats: {
      components: components.length,
      nets: nets.length,
      pins: components.reduce((n, c) => n + c.pins.length, 0),
    },
    components,
    nets,
    designRule: netlist.designRule || {},
    differentialPairs: netlist.differentialPairGroups || netlist.differentialPair || {},
    pinsAvailable,
    drcAvailable: options.drcProvided ?? Array.isArray(drc),
    geometry: geo,
    drc,
    warnings,
  };
}

export function parseNetlistFile(file, options = {}) {
  if (!fs.existsSync(file)) throw new Error(`网表文件不存在: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  let netlist;
  try { netlist = JSON.parse(raw); }
  catch (err) {
    if (/\.net$/i.test(file)) throw new Error('v1 不支持 Protel2 .net，请在 EDA 中导出 .enet（JLCEDA 类型）');
    throw new Error(`网表不是合法 JSON: ${err.message}`);
  }
  return buildModel(netlist, { ...options, source: { ...(options.source || {}), mode: 'file', netlistType: 'JLCEDA' } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const netlistFile = args[0];
  const out = args[1] || null;
  if (!netlistFile) {
    console.error('用法: node parse-netlist.mjs <design.enet> [model.json]');
    process.exit(3);
  }
  try {
    const model = parseNetlistFile(netlistFile, {
      pinsFile: args[2] || null,
    });
    if (out) {
      ensureDir(path.dirname(path.resolve(out)));
      writeJson(out, model);
      console.log(`model written: ${out} (${model.stats.components} components, ${model.stats.nets} nets)`);
    } else {
      process.stdout.write(JSON.stringify(model, null, 2));
    }
  } catch (err) {
    console.error(err.message);
    process.exit(4);
  }
}
