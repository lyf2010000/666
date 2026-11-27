import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, createLogger, levenshtein, computeFindingKey, pageLabelOf } from './lib/util.mjs';
import { classifyPinName, classifyNet, pinNameSegments, isPlaceholderValue } from './lib/classify-components.mjs';
import { readBom, compareBom } from './bom-check.mjs';

function mkFinding(ruleId, severity, confidence, category, params, evidence, location = {}, extra = {}) {
  return {
    source: 'rule',
    ruleId,
    messageKey: `${ruleId}.title`,
    params,
    severity,
    confidence,
    category,
    evidence,
    location: {
      pages: location.pages || [],
      designators: [...new Set(location.designators || [])],
      uids: [...new Set(location.uids || [])],
      nets: [...new Set(location.nets || [])],
    },
    heuristic: true,
    ...extra,
  };
}

function pinEvidence(comp, pin) {
  return { kind: 'pin', uid: comp.uid, designator: comp.designator, pin: pin.number, name: pin.name, net: pin.net };
}

function netEvidence(net) {
  return { kind: 'net', net: net.name, pins: (net.pins || []).map(p => `${p.designator}.${p.pin}`) };
}

function isPowerOrGroundPin(pin) {
  return classifyPinName(pin.name, pin.pinType).isPower || classifyPinName(pin.name, pin.pinType).isGround;
}

function componentNets(comp) {
  return [...new Set(comp.pins.map(p => p.net).filter(Boolean))];
}

function findComponentsTouching(model, netName) {
  return model.components.filter(c => c.pins.some(p => p.net === netName));
}

function isPassiveTwoPin(comp) {
  return comp.pins.length === 2 && ['resistor', 'resistor_array', 'capacitor', 'inductor', 'ferrite', 'fuse', 'switch', 'diode', 'led', 'crystal'].includes(comp.category);
}

function isSourceComponent(comp) {
  return ['connector', 'regulator', 'power_source'].includes(comp.category);
}

function hasPinOnNet(comp, netName) {
  return comp.pins.some(p => p.net === netName);
}

function otherPinNet(comp, netName) {
  const pins = comp.pins.filter(p => p.net === netName);
  if (pins.length !== 1) return null;
  const other = comp.pins.find(p => p !== pins[0]);
  return other?.net || null;
}

function isGroundNetName(name) {
  return classifyNet(name).isGround;
}
function isPowerNetName(name) {
  return classifyNet(name).isPower;
}

function findResistorToPower(model, netName) {
  for (const c of model.components) {
    if (!['resistor', 'resistor_array'].includes(c.category)) continue;
    if (!hasPinOnNet(c, netName)) continue;
    const other = otherPinNet(c, netName);
    if (other && isPowerNetName(other)) return { comp: c, otherNet: other };
  }
  return null;
}

function findResistorToGround(model, netName) {
  for (const c of model.components) {
    if (!['resistor', 'resistor_array'].includes(c.category)) continue;
    if (!hasPinOnNet(c, netName)) continue;
    const other = otherPinNet(c, netName);
    if (other && isGroundNetName(other)) return { comp: c, otherNet: other };
  }
  return null;
}

function findCapToGround(model, netName) {
  for (const c of model.components) {
    if (c.category !== 'capacitor') continue;
    if (!hasPinOnNet(c, netName)) continue;
    const other = otherPinNet(c, netName);
    if (other && isGroundNetName(other)) return c;
  }
  return null;
}

function findCapToGroundOneHop(model, netName) {
  const direct = findCapToGround(model, netName);
  if (direct) return direct;
  for (const c of model.components) {
    if (!['ferrite', 'resistor', 'inductor'].includes(c.category) || c.pins.length !== 2) continue;
    if (!hasPinOnNet(c, netName)) continue;
    if (c.category === 'resistor' && !isZeroOhmValue(c.rawValue ?? c.displayValue)) continue;
    const other = otherPinNet(c, netName);
    if (!other || isGroundNetName(other)) continue;
    const cap = findCapToGround(model, other);
    if (cap) return cap;
  }
  return null;
}

function findSeriesResistor(model, netName) {
  return model.components.find(c =>
    ['resistor', 'resistor_array'].includes(c.category) &&
    hasPinOnNet(c, netName) && otherPinNet(c, netName),
  ) || null;
}

function findResistorBetween(model, netA, netB) {
  return model.components.find(c => {
    if (!['resistor', 'resistor_array'].includes(c.category) || c.pins.length !== 2) return false;
    const nets = c.pins.map(p => p.net);
    return (nets[0] === netA && nets[1] === netB) || (nets[0] === netB && nets[1] === netA);
  }) || null;
}

function findDiodeAcross(model, netA, netB) {
  return model.components.find(c => {
    if (c.category !== 'diode' || c.pins.length !== 2) return false;
    const nets = c.pins.map(p => p.net);
    return (nets[0] === netA && nets[1] === netB) || (nets[0] === netB && nets[1] === netA);
  }) || null;
}

function pinByName(comp, re) {
  return comp.pins.find(p => pinNameSegments(p.name).some(s => re.test(s))) || null;
}

function pinsByName(comp, re) {
  return comp.pins.filter(p => pinNameSegments(p.name).some(s => re.test(s)));
}

/** 电源输出/供电输入引脚名：即使器件被归为 ic，也能为电源网络提供来源证据（R007）。 */
const POWER_SOURCE_PIN_RE = /^(VBUS|VOUT|VO\d*|V3|VCORE_OUT|\d+(\.\d+)?VOUT|3V3OUT|5VOUT)$/i;

/** 2~3 脚、全部引脚接不同电源网络的器件视为电源选择跳线/排针，BFS 可穿越（R007）。 */
function isPowerJumper(comp) {
  if (comp.pins.length < 2 || comp.pins.length > 3) return false;
  if (['resistor', 'resistor_array', 'capacitor', 'inductor', 'ferrite', 'fuse', 'diode', 'led', 'crystal', 'switch'].includes(comp.category)) return false;
  return comp.pins.every(p => p.net && isPowerNetName(p.net) && !isGroundNetName(p.net));
}

/** 从网络名解析电压：+5V→5、3V3→3.3、12V→12；VCC 等无语义名返回 null。 */
function parseRailVoltage(name) {
  const s = String(name ?? '').trim();
  let m = s.match(/^(\d+)V(\d+)$/i);
  if (m) return parseFloat(`${m[1]}.${m[2]}`);
  m = s.match(/^[+]?(\d+(?:\.\d+)?)V/i);
  if (m) return parseFloat(m[1]);
  return null;
}

/** 封装码（0805/0603 等）不是电气值，解析阻值/比较料号值时排除。 */
const PACKAGE_CODE_RE = /^(0201|0402|0603|0805|1206|1210|1812|2010|2512)$/;

/** 解析阻值：4700、4.7K、4K7、10R、0R0、4.7kΩ 等常见写法，返回欧姆或 null。 */
function parseResistance(value) {
  const v = String(value ?? '').trim().toUpperCase().replace(/[Ω\s]/g, '').replace(/OHMS?$/, '');
  if (!v || PACKAGE_CODE_RE.test(v)) return null;
  let m = v.match(/^(\d+(?:\.\d+)?)([RKM])(\d*)$/);
  if (m) {
    const mult = { R: 1, K: 1e3, M: 1e6 }[m[2]];
    const base = m[3] ? parseFloat(`${m[1]}.${m[3]}`) : parseFloat(m[1]);
    return base * mult;
  }
  m = v.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return parseFloat(m[1]);
  return null;
}

/** 0Ω/跳线阻值：0、0R、0Ω、0OHM、0R0、0.0、000 等常见写法。 */
function isZeroOhmValue(value) {
  const v = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return /^(0+(\.0+)?|0R0+)(R|Ω|OHM)?$/.test(v);
}

/** NC 候选引脚名：整词 NC/DNC/NO_CONNECT/RESERVED，或 `_NC`/`(NC)`/数字后缀（PRD §6.5 R002 边界）。 */
function isNcPinName(name) {
  const n = String(name || '').trim().toUpperCase().replace(/[()]/g, '_').replace(/_+$/, '');
  return /^(NC|DNC|NO_CONNECT|RESERVED)([_-]?\d+)?$/.test(n) ||
    /[_-](NC|DNC|NO_CONNECT|RESERVED)([_-]?\d+)?$/.test(n);
}

function countResistorsOn(model, netName) {
  return model.components.filter(c =>
    ['resistor', 'resistor_array'].includes(c.category) && hasPinOnNet(c, netName),
  ).length;
}

function r007PowerSource(model, netName) {
  const visited = new Set([netName]);
  let frontier = [netName];
  for (let depth = 0; depth <= 5 && frontier.length; depth++) {
    const next = [];
    for (const net of frontier) {
      for (const c of findComponentsTouching(model, net)) {
        if (isSourceComponent(c)) return { found: true, via: c.designator, depth };
        // 引脚名证据：VBUS/VOUT/V3 等输出脚直接挂在本网上即视为来源，不依赖器件分类。
        if (c.pins.some(p => p.net === net && pinNameSegments(p.name).some(s => POWER_SOURCE_PIN_RE.test(s)))) {
          return { found: true, via: c.designator, depth };
        }
        // 3 脚电源选择排针（引脚名为数字）：允许穿越到其它电源脚所在网络。
        if (isPowerJumper(c)) {
          for (const p of c.pins) {
            const other = p.net;
            if (!other || other === net || visited.has(other) || other.startsWith('$')) continue;
            visited.add(other);
            next.push(other);
          }
          continue;
        }
        if (!isPassiveTwoPin(c)) continue;
        const other = otherPinNet(c, net);
        if (!other || visited.has(other) || other.startsWith('$')) continue;
        if (isGroundNetName(other)) continue;
        visited.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return { found: false };
}

/** R040：地网络是否经直流通路（0Ω/磁珠/电感/保险丝/开关/二极管/网络桥）连到其它地网络。电容耦合不算直流连接。 */
function r040GroundTie(model, netName, groundNames) {
  const grounds = new Set(groundNames);
  const visited = new Set([netName]);
  let frontier = [netName];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const net of frontier) {
      for (const c of findComponentsTouching(model, net)) {
        if (c.pins.length !== 2) continue;
        if (!['resistor', 'inductor', 'ferrite', 'fuse', 'switch', 'diode', 'other'].includes(c.category)) continue;
        const other = otherPinNet(c, net);
        if (!other || visited.has(other)) continue;
        if (grounds.has(other)) return true;
        visited.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return false;
}

function ruleR014(model) {
  const findings = [];
  const groups = model.differentialPairs;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const [name, group] of Object.entries(groups)) {
      const nets = Array.isArray(group) ? group : (group?.nets || group?.members || []);
      if (!Array.isArray(nets)) continue;
      const missing = [];
      if (nets.length === 1) missing.push(nets[0]);
      if (nets.length === 0) missing.push(name);
      if (missing.length) {
        findings.push(mkFinding('R014', 'P2', 'high', 'interface', { net: name },
          [{ kind: 'net', net: name, pins: [] }], { nets: [name] }));
      }
    }
  }
  // Name-suffix fallback: FOO_P without FOO_N (or vice versa), and FOO+ without FOO-.
  const names = new Set(model.nets.map(n => n.name));
  for (const n of names) {
    const m = n.match(/^(.*?)([_-])(P|N|DP|DM)$/i);
    if (!m) continue;
    const suffix = m[3].toUpperCase();
    const altSuffix = suffix === 'P' ? 'N' : suffix === 'N' ? 'P' : suffix === 'DP' ? 'DM' : 'DP';
    const base = `${m[1]}${m[2]}`;
    if (!names.has(base + altSuffix) && !names.has(base + altSuffix.toLowerCase())) {
      findings.push(mkFinding('R014', 'P2', 'medium', 'interface', { net: n },
        [{ kind: 'net', net: n, pins: (model.nets.find(x => x.name === n)?.pins || []).map(p => `${p.designator}.${p.pin}`) }],
        { nets: [n] }));
    }
  }
  for (const n of names) {
    const net = model.nets.find(x => x.name === n);
    if (net?.isPower || net?.isGround || net?.isAuto) continue;
    const m = n.match(/^(.+)([+-])$/);
    if (!m) continue;
    const alt = m[1] + (m[2] === '+' ? '-' : '+');
    if (!names.has(alt)) {
      findings.push(mkFinding('R014', 'P2', 'medium', 'interface', { net: n },
        [{ kind: 'net', net: n, pins: (net?.pins || []).map(p => `${p.designator}.${p.pin}`) }],
        { nets: [n] }));
    }
  }
  return findings;
}

export function lintModel(model, options = {}) {
  const log = options.logger || createLogger();
  const mode = options.mode || 'standard';
  const strict = mode === 'strict';
  const bom = options.bom || readBom(options.bomFile);
  const findings = [];
  const openQuestions = [];
  const skippedRules = [];
  const push = (f) => { findings.push(f); };
  const enabled = mode === 'quick'
    ? new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R014', 'R015', 'R016', 'R017', 'R026', 'R029'])
    : mode === 'strict'
      ? new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009', 'R010', 'R011',
        'R012', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018', 'R019', 'R020', 'R023', 'R025', 'R026',
        'R027', 'R028', 'R029', 'R030', 'R031', 'R032', 'R033', 'R034', 'R035', 'R036', 'R037', 'R038', 'R039',
        'R040', 'R041', 'R042', 'R043', 'R044', 'R045', 'R046', 'R047', 'R048', 'R049', 'R050', 'R051', 'R052',
        'R053', 'R054', 'R055', 'R056', 'R058', 'R060'])
      : new Set(['R001', 'R002', 'R003', 'R004', 'R005', 'R006', 'R007', 'R008', 'R009', 'R010', 'R011',
        'R012', 'R013', 'R014', 'R015', 'R016', 'R017', 'R018', 'R019', 'R020', 'R023', 'R026', 'R029',
        'R030', 'R031', 'R032', 'R033', 'R034', 'R035', 'R036', 'R037', 'R038', 'R039',
        'R040', 'R041', 'R042', 'R043', 'R046', 'R047', 'R048', 'R049', 'R050', 'R051', 'R052',
        'R054', 'R056', 'R058']);

  // R001 single-pin nets.
  for (const net of model.nets) {
    if (net.pinCount !== 1) continue;
    const p = net.pins[0];
    const comp = model.components.find(c => c.uid === p.uid);
    const prefix = String(comp?.designator || '').match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';
    if (['testpoint', 'antenna'].includes(comp?.category) || ['TP', 'TEST', 'ANT', 'JMP'].includes(prefix)) continue;
    if (comp?.category === 'connector' && comp.pins.length === 1) continue;
    push(mkFinding('R001', 'P2', 'high', 'connectivity', { net: net.name, designator: p.designator, pin: p.pin },
      [netEvidence(net), comp ? pinEvidence(comp, comp.pins.find(x => x.number === p.pin) || {}) : { kind: 'net', net: net.name }],
      { designators: [p.designator], uids: [p.uid], nets: [net.name] },
      { _subjects: [`net:${net.name}`] }));
  }

  // R002 floating pins.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net || pin.noConnect) continue;
      if (isNcPinName(pin.name)) {
        openQuestions.push({
          question: `${comp.designator}.${pin.number} 引脚名为 ${pin.name}，是否为故意不接？`,
          related: [`${comp.designator}.${pin.number}`],
          why: '引脚名暗示 NC，但缺少 noConnect 标记。',
        });
        continue;
      }
      // Type-C SBU 在仅用 USB2.0 时通常故意悬空，作为待确认问题而非缺陷。
      if (/^SBU\d*$/i.test(String(pin.name || '').trim())) {
        openQuestions.push({
          question: `${comp.designator}.${pin.number}（${pin.name}）悬空，若仅使用 USB2.0 可忽略，请确认。`,
          related: [`${comp.designator}.${pin.number}`],
          why: 'Type-C SBU 引脚在 USB2.0 应用中通常不连接。',
        });
        continue;
      }
      const isControl = pinNameSegments(pin.name).some(s => /^(EN|ENABLE|RST|RESET|NRST|CLK|CS|INT|BOOT|BOOT0)(\d+)?$/i.test(s));
      const severity = isControl ? 'P1' : 'P2';
      const confidence = model.pinsAvailable ? 'high' : 'medium';
      push(mkFinding('R002', severity, confidence, 'connectivity',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: [] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R003 duplicate designators.
  const byDesignator = new Map();
  for (const c of model.components) {
    if (!c.designator) continue;
    if (!byDesignator.has(c.designator)) byDesignator.set(c.designator, []);
    byDesignator.get(c.designator).push(c);
  }
  for (const [designator, comps] of byDesignator) {
    if (comps.length < 2) continue;
    const groupIds = comps.map(c => c.groupId).filter(Boolean);
    if (comps.every(c => c.groupId) && new Set(groupIds).size === 1) continue;
    const sameDevice = comps.every(c => c.device && c.device === comps[0].device) ||
      comps.every(c => c.manufacturerPart && c.manufacturerPart === comps[0].manufacturerPart);
    let disjoint = false;
    if (sameDevice) {
      const sets = comps.map(c => new Set(c.pins.map(p => p.number).filter(n => !isPowerOrGroundPin(c.pins.find(p => p.number === n) || {}))));
      disjoint = sets.every((s, i) => sets.every((t, j) => i === j || [...s].every(n => !t.has(n))));
    }
    const severity = disjoint ? 'P3' : 'P0';
    push(mkFinding('R003', severity, 'high', 'connectivity',
      { designator, uids: comps.map(c => c.uid).join(', ') },
      comps.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator })),
      { designators: [designator], uids: comps.map(c => c.uid) }));
  }

  // R004 nets with no pins.
  for (const net of model.nets) {
    if (net.pinCount !== 0) continue;
    push(mkFinding('R004', 'P2', 'high', 'connectivity', { net: net.name },
      [netEvidence(net)], { nets: [net.name] }, { _subjects: [`net:${net.name}`] }));
  }

  // R005 DRC dangling nets.
  if (model.drcAvailable || (Array.isArray(model.drc) && model.drc.length)) {
    const seen = new Set();
    for (const item of model.drc) {
      if (item?.rule !== 'SHOWDANDLING') continue;
      for (const prim of item.primitives || []) {
        const netName = prim.name || '';
        const key = `${netName}|${prim.primitiveId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const net = model.nets.find(n => n.name === netName);
        const evidence = [{ kind: 'drc', rule: 'SHOWDANDLING', name: netName, primitiveId: prim.primitiveId || null }];
        if (net) evidence.push(netEvidence(net));
        push(mkFinding('R005', 'P2', 'high', 'connectivity', { net: netName || prim.primitiveId || 'UNKNOWN' },
          evidence, { nets: netName ? [netName] : [] },
          { drcRule: 'SHOWDANDLING', _subjects: netName ? [`net:${netName}`] : [] }));
      }
    }
  } else {
    skippedRules.push({ ruleId: 'R005', reason: 'drc unavailable', uids: [] });
  }

  // R006 power/ground pins floating.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower && !cls.isGround) continue;
      // 可选电源输出脚（VOUT/3V3OUT/VBUS 等）悬空降 P1，不按 P0 短路级处理（PRD R006 边界）。
      const isOptionalOutput = /^(VOUT|VO\d*|VBUS|\d+(\.\d+)?V\d*OUT)$/i.test(String(pin.name || '').trim());
      const downgraded = pin.noConnect || isOptionalOutput;
      const severity = downgraded ? 'P1' : 'P0';
      const confidence = downgraded ? 'medium' : 'high';
      push(mkFinding('R006', severity, confidence, 'power',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R007 power nets without a source.
  for (const net of model.nets) {
    if (!net.isPower || net.powerKind === 'reference' || net.isGround) continue;
    if (net.pinCount < 2) continue;
    if (!r007PowerSource(model, net.name).found) {
      push(mkFinding('R007', 'P2', 'medium', 'power', { net: net.name },
        [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R008 IC decoupling.
  for (const comp of model.components) {
    if (!['ic', 'regulator'].includes(comp.category)) continue;
    for (const pin of comp.pins) {
      if (!pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower || cls.isGround) continue;
      const net = model.nets.find(n => n.name === pin.net);
      if (net?.powerKind === 'reference' || cls.kind === 'reference') continue;
      if (!findCapToGroundOneHop(model, pin.net)) {
        push(mkFinding('R008', 'P2', 'medium', 'power', { designator: comp.designator, net: pin.net },
          [pinEvidence(comp, pin), netEvidence(net || { name: pin.net, pins: [] })],
          { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] },
          { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
      }
    }
  }

  // R009 I2C pull-ups.
  const i2cNets = model.nets.filter(n => /(^|[_-])(SCL|SDA)\d*([_-]|$)/i.test(n.name));
  for (const net of i2cNets) {
    if (findResistorToPower(model, net.name)) continue;
    const array = model.components.find(c => c.category === 'resistor_array' && hasPinOnNet(c, net.name));
    if (array) {
      if (enabled.has('R009')) openQuestions.push({
        question: `${net.name} 连接到排阻 ${array.designator}，请确认排阻是否已提供上拉。`,
        related: [net.name, array.designator],
        why: '排阻内部拓扑无法从网表确定。',
      });
      continue;
    }
    push(mkFinding('R009', 'P1', 'medium', 'interface', { net: net.name },
      [netEvidence(net)], { nets: [net.name] }));
  }

  // R010 reset pull-up/down.
  const RESET_PIN_RE = /^(N?RST|N?RESET|RES|XRES|MCLR)(\d+|#|_N|N)?$/i;
  for (const comp of model.components) {
    if (['connector', 'testpoint', 'mechanical'].includes(comp.category)) continue;
    for (const pin of comp.pins) {
      if (!pin.net || !pinNameSegments(pin.name).some(s => RESET_PIN_RE.test(s))) continue;
      // 直接 tied 到电源/地属于固定电平（R046 负责危险极性），不在上拉/下拉检查范围。
      if (isPowerNetName(pin.net) || isGroundNetName(pin.net)) continue;
      const has = model.components.some(c => {
        if (!['resistor', 'resistor_array'].includes(c.category) || !hasPinOnNet(c, pin.net)) return false;
        const other = otherPinNet(c, pin.net);
        return Boolean(other) && (isPowerNetName(other) || isGroundNetName(other));
      });
      if (!has) {
        push(mkFinding('R010', 'P2', 'medium', 'interface',
          { designator: comp.designator, pin: pin.number },
          [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] },
          { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
      }
    }
  }

  // R011 BOOT floating.
  for (const comp of model.components) {
    for (const pin of comp.pins) {
      if (pin.net || !/^BOOT0?$/i.test(pin.name || '')) continue;
      push(mkFinding('R011', 'P1', 'high', 'interface',
        { designator: comp.designator, pin: pin.number },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R012 crystal load capacitors.
  for (const comp of model.components) {
    if (comp.category !== 'crystal') continue;
    // 有源振荡器（带电源引脚）不需要外部负载电容。
    if (comp.pins.some(p => classifyPinName(p.name, p.pinType).isPower)) continue;
    // 4 脚晶振的接地/电源焊盘不参与负载电容判定。
    const nets = componentNets(comp).filter(n => !isGroundNetName(n) && !isPowerNetName(n));
    const missing = nets.filter(n => !findCapToGround(model, n));
    if (missing.length) {
      push(mkFinding('R012', 'P2', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...missing.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets: missing }));
    }
  }

  // R013 LED series resistor.
  for (const comp of model.components) {
    if (comp.category !== 'led') continue;
    const nets = componentNets(comp);
    if (!nets.some(n => findSeriesResistor(model, n))) {
      push(mkFinding('R013', 'P1', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...nets.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets }));
    }
  }

  // R014 differential pairs.
  findings.push(...ruleR014(model));

  // R015 connector power/ground pins floating.
  for (const comp of model.components) {
    if (comp.category !== 'connector') continue;
    for (const pin of comp.pins) {
      if (pin.net) continue;
      const cls = classifyPinName(pin.name, pin.pinType);
      if (!cls.isPower && !cls.isGround) continue;
      push(mkFinding('R015', 'P1', 'high', 'connectivity',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R016 missing/placeholder values.
  for (const comp of model.components) {
    if (['connector', 'testpoint', 'mechanical'].includes(comp.category)) continue;
    if (comp.dnp === true) continue;
    if (!comp.valuePlaceholder && !(comp.rawValue == null || String(comp.rawValue).trim() === '')) continue;
    const value = comp.rawValue == null ? '—' : String(comp.rawValue);
    // dnpCandidate（Add into BOM=false）只产生 open question，不产生 high-confidence finding。
    if (comp.dnpCandidate) {
      openQuestions.push({
        question: `${comp.designator} 的 Value 为 ${value || '空'}，且未加入 BOM，是否为 DNP？`,
        related: [comp.designator],
        why: '只有 Add into BOM=false，缺少显式 DNP 属性。',
      });
      continue;
    }
    if (!comp.addIntoBom) continue;
    // BOM 已提供有效值时，网表缺值只是标注不完整，降为 P3。
    const bomRow = bom.available
      ? (bom.byDesignator.get(comp.designator) || []).find(r => r.value && !isPlaceholderValue(r.value) && !PACKAGE_CODE_RE.test(String(r.value).trim().toUpperCase()))
      : null;
    push(mkFinding('R016', bomRow ? 'P3' : 'P2', bomRow ? 'medium' : 'high', 'component',
      { designator: comp.designator, value, inBom: bomRow ? 'yes' : 'no' },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator, property: 'Value', value: comp.rawValue }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R017 missing footprint.
  for (const comp of model.components) {
    if (!comp.convertToPcb || comp.footprint) continue;
    push(mkFinding('R017', 'P1', 'high', 'component', { designator: comp.designator },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R018 BOM/PCB flag combinations.
  for (const comp of model.components) {
    if (['mechanical', 'testpoint'].includes(comp.category)) continue;
    if (comp.addIntoBom && !comp.convertToPcb) {
      push(mkFinding('R018', 'P3', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
        { designators: [comp.designator], uids: [comp.uid] }));
    } else if (!comp.addIntoBom && comp.convertToPcb) {
      push(mkFinding('R018', 'P3', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
        { designators: [comp.designator], uids: [comp.uid] }));
    } else if (!comp.addIntoBom && !comp.convertToPcb && comp.dnp !== true && comp.pins.some(p => p.net)) {
      // 既不进 BOM 也不转 PCB 但仍有连接引脚（PRD R018 组合表）；显式 DNP 豁免。
      push(mkFinding('R018', 'P2', 'medium', 'component', { designator: comp.designator },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
        { designators: [comp.designator], uids: [comp.uid] }));
    }
  }

  // R019 missing supplier part.
  for (const comp of model.components) {
    if (!comp.addIntoBom || comp.supplierPart) continue;
    push(mkFinding('R019', 'P3', 'medium', 'component', { designator: comp.designator },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }],
      { designators: [comp.designator], uids: [comp.uid] }));
  }

  // R020 similar net names.
  // 排除：端口/引脚式自动名（P000、UART1）、过短名（DN/DP/TX/RX）、以及互补后缀的有意配对（DP/DN、+/-、SCL/SDA）。
  const PORT_STYLE_RE = /^[A-Za-z]{1,4}\d+$/;
  const PAIR_SUFFIXES = [['DP', 'DM'], ['DP', 'DN'], ['P', 'N'], ['+', '-'], ['H', 'L'], ['A', 'B'], ['TX', 'RX'], ['SCL', 'SDA'], ['POS', 'NEG']];
  const isIntentionalPair = (a, b) => {
    const strip = s => s.replace(/\d+$/, '');
    const re = /^(.*?)(DP|DM|DN|SCL|SDA|POS|NEG|TX|RX|P|N|H|L|A|B|\+|-)$/i;
    const ma = strip(a).match(re), mb = strip(b).match(re);
    if (!ma || !mb || ma[1].toLowerCase() !== mb[1].toLowerCase()) return false;
    const sa = ma[2].toUpperCase(), sb = mb[2].toUpperCase();
    return PAIR_SUFFIXES.some(([x, y]) => (sa === x && sb === y) || (sa === y && sb === x));
  };
  const candidates = model.nets.filter(n => !n.isAuto && !n.isPower && !n.isGround &&
    n.name.length > 3 && !PORT_STYLE_RE.test(n.name));
  const seenPairs = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].name, b = candidates[j].name;
      const norm = s => s.toLowerCase().replace(/[_-]/g, '');
      if (a === b) continue;
      if (isIntentionalPair(a, b)) continue;
      const threshold = strict ? 2 : 1;
      const na = norm(a), nb = norm(b);
      if (Math.abs(na.length - nb.length) > threshold) continue;
      if (levenshtein(na, nb) > threshold) continue;
      const key = [a, b].sort().join('|');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      push(mkFinding('R020', 'P3', 'low', 'readability', { netA: a, netB: b },
        [{ kind: 'net', net: a, pins: [] }, { kind: 'net', net: b, pins: [] }],
        { nets: [a, b] }));
    }
  }

  // R023 power input protection (standard+; USB 供电板在 standard 下也需要入口保护检查).
  for (const net of model.nets) {
    if (!net.isPower || net.isGround) continue;
    const connectors = findComponentsTouching(model, net.name).filter(c => c.category === 'connector');
    if (!connectors.length) continue;
    const hasProtection = findComponentsTouching(model, net.name).some(c => ['fuse', 'tvs'].includes(c.category));
    if (!hasProtection) {
      push(mkFinding('R023', 'P3', 'low', 'power', { net: net.name }, [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R025 test point on key rails (strict).
  if (strict) {
    for (const net of model.nets) {
      if (!net.isPower || net.isGround || net.powerKind === 'reference') continue;
      const hasTp = findComponentsTouching(model, net.name).some(c => c.category === 'testpoint' ||
        /^TP|^TEST/i.test(c.designator || ''));
      if (!hasTp) {
        push(mkFinding('R025', 'P3', 'low', 'readability', { net: net.name }, [netEvidence(net)], { nets: [net.name] }));
      }
    }
  }

  // R026 BOM consistency.
  const bomResult = compareBom(model, bom);
  if (!bomResult.available) {
    skippedRules.push({ ruleId: 'R026', reason: `bom ${bomResult.reason || 'unavailable'}`, uids: [] });
  } else {
    for (const issue of bomResult.issues) {
      const severity = issue.kind === 'supplier-mismatch' ? 'P3' : 'P2';
      const designators = issue.designators || [];
      const comps = designators.map(d => model.components.find(c => c.designator === d)).filter(Boolean);
      push(mkFinding('R026', severity, 'high', 'bom', { detail: issue.detail },
        [{ kind: 'bom', designators, detail: issue.detail }, ...comps.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator }))],
        { designators, uids: comps.map(c => c.uid) }));
    }
  }

  // R027 unused op-amp channels (strict).
  if (strict) {
    for (const comp of model.components) {
      if (comp.category !== 'ic') continue;
      const desc = `${comp.description} ${comp.name} ${comp.lcscPartName}`;
      if (!/\bop[- ]?amp\b|运放/i.test(desc)) continue;
      const floating = comp.pins.filter(p => !p.net && /^IN\d*[+-]?$|^IN[+-]\d*$/i.test(p.name || ''));
      if (floating.length) {
        push(mkFinding('R027', 'P3', 'medium', 'component', { designator: comp.designator },
          floating.map(p => pinEvidence(comp, p)), { designators: [comp.designator], uids: [comp.uid] },
          { _subjects: floating.map(p => `pin:${comp.uid}:${p.number}`) }));
      }
    }
  }

  // R028 unused logic gate inputs (strict).
  if (strict) {
    for (const comp of model.components) {
      if (comp.category !== 'ic') continue;
      for (const pin of comp.pins) {
        if (pin.net || !/^(IN|EN|CLK|RST)(\d+)?$/i.test(pin.name || '')) continue;
        push(mkFinding('R028', 'P2', 'medium', 'component',
          { designator: comp.designator, pin: pin.number },
          [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid] },
          { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
      }
    }
  }

  // R030 MOSFET gate pull-down missing.
  for (const comp of model.components) {
    if (comp.category !== 'mosfet') continue;
    const gate = pinByName(comp, /^(G|GATE)\d*$/);
    if (!gate || !gate.net) continue;
    const source = pinByName(comp, /^(S|SOURCE)\d*$/);
    const sourceNet = source?.net || null;
    const refNets = new Set(
      sourceNet
        ? [sourceNet, ...(isGroundNetName(sourceNet)
          ? model.nets.filter(n => n.isGround).map(n => n.name)
          : isPowerNetName(sourceNet) ? model.nets.filter(n => n.isPower).map(n => n.name) : [])]
        : model.nets.filter(n => n.isGround).map(n => n.name),
    );
    const hasPulldown = [...refNets].some(ref => ref && ref !== gate.net && findResistorBetween(model, gate.net, ref));
    if (!hasPulldown) {
      push(mkFinding('R030', 'P2', 'medium', 'component',
        { designator: comp.designator, pin: gate.number },
        [pinEvidence(comp, gate)], { designators: [comp.designator], uids: [comp.uid], nets: [gate.net] },
        { _subjects: [`pin:${comp.uid}:${gate.number}`] }));
    }
  }

  // R031 BJT base resistor missing.
  for (const comp of model.components) {
    if (comp.category !== 'transistor') continue;
    const base = pinByName(comp, /^(B|BASE)\d*$/);
    if (!base || !base.net) continue;
    const hasResistor = model.components.some(c =>
      ['resistor', 'resistor_array'].includes(c.category) && hasPinOnNet(c, base.net) && otherPinNet(c, base.net));
    if (!hasResistor) {
      push(mkFinding('R031', 'P2', 'medium', 'component',
        { designator: comp.designator, pin: base.number },
        [pinEvidence(comp, base)], { designators: [comp.designator], uids: [comp.uid], nets: [base.net] },
        { _subjects: [`pin:${comp.uid}:${base.number}`] }));
    }
  }

  // R032 relay coil flyback diode missing.
  for (const comp of model.components) {
    if (comp.category !== 'relay') continue;
    let coilPins = comp.pins.filter(p => /COIL/i.test(p.name || ''));
    if (!coilPins.length && comp.pins.length === 2) coilPins = comp.pins;
    const coilNets = [...new Set(coilPins.map(p => p.net).filter(Boolean))];
    if (coilNets.length !== 2) continue;
    if (!findDiodeAcross(model, coilNets[0], coilNets[1])) {
      push(mkFinding('R032', 'P1', 'medium', 'component', { designator: comp.designator },
        coilPins.map(p => pinEvidence(comp, p)).concat(coilNets.map(n => ({ kind: 'net', net: n, pins: [] }))),
        { designators: [comp.designator], uids: [comp.uid], nets: coilNets }));
    }
  }

  // R033 regulator feedback divider incomplete.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    for (const fb of pinsByName(comp, /^(FB|VFB|FEEDBACK|ADJ)\d*$/)) {
      if (!fb.net) continue;
      const count = countResistorsOn(model, fb.net);
      if (count < 2) {
        push(mkFinding('R033', 'P2', 'medium', 'power',
          { designator: comp.designator, pin: fb.number },
          [pinEvidence(comp, fb)], { designators: [comp.designator], uids: [comp.uid], nets: [fb.net] }));
      }
    }
  }

  // R034 regulator enable pin floating.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    for (const en of pinsByName(comp, /^(EN|ENABLE|SHDN|UVLO)\d*$/)) {
      if (en.net) continue;
      push(mkFinding('R034', 'P1', 'medium', 'power',
        { designator: comp.designator, pin: en.number },
        [pinEvidence(comp, en)], { designators: [comp.designator], uids: [comp.uid] },
        { _subjects: [`pin:${comp.uid}:${en.number}`] }));
    }
  }

  // R035 two-pin passive has both pins on the same net.
  for (const comp of model.components) {
    if (!['resistor', 'capacitor', 'inductor', 'ferrite', 'diode', 'led', 'crystal', 'fuse', 'tvs'].includes(comp.category)) continue;
    if (comp.pins.length !== 2) continue;
    const [a, b] = comp.pins;
    if (!a.net || a.net !== b.net) continue;
    if (isZeroOhmValue(comp.rawValue ?? comp.displayValue)) continue;
    push(mkFinding('R035', 'P2', 'high', 'connectivity',
      { designator: comp.designator, net: a.net },
      [pinEvidence(comp, a), pinEvidence(comp, b)],
      { designators: [comp.designator], uids: [comp.uid], nets: [a.net] }));
  }

  // R036 regulator output capacitor missing.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    for (const out of pinsByName(comp, /^(OUT|VOUT|VO)\d*$/)) {
      if (!out.net || isGroundNetName(out.net)) continue;
      if (!findCapToGround(model, out.net)) {
        push(mkFinding('R036', 'P2', 'medium', 'power',
          { designator: comp.designator, pin: out.number, net: out.net },
          [pinEvidence(comp, out)], { designators: [comp.designator], uids: [comp.uid], nets: [out.net] },
          { _subjects: [`pin:${comp.uid}:${out.number}`] }));
      }
    }
  }

  // R037 LED reverse-biased (anode tied to ground).
  for (const comp of model.components) {
    if (comp.category !== 'led') continue;
    const anode = pinByName(comp, /^A\d*$/);
    const cathode = pinByName(comp, /^K\d*$/);
    if (!anode || !anode.net || !cathode || !cathode.net) continue;
    if (anode.net === cathode.net) continue;
    if (isGroundNetName(anode.net)) {
      push(mkFinding('R037', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, anode), pinEvidence(comp, cathode)],
        { designators: [comp.designator], uids: [comp.uid], nets: [anode.net, cathode.net] }));
    }
  }

  // R038 polarized capacitor reversed.
  for (const comp of model.components) {
    if (comp.category !== 'capacitor') continue;
    const plus = comp.pins.find(p => /^\+$/.test(String(p.name || '').trim()));
    const minus = comp.pins.find(p => /^-$/.test(String(p.name || '').trim()));
    if (!plus || !minus || !plus.net || !minus.net || plus.net === minus.net) continue;
    if (isGroundNetName(plus.net) || isPowerNetName(minus.net)) {
      push(mkFinding('R038', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, plus), pinEvidence(comp, minus)],
        { designators: [comp.designator], uids: [comp.uid], nets: [plus.net, minus.net] }));
    }
  }

  // R039 relay flyback diode orientation.
  for (const comp of model.components) {
    if (comp.category !== 'relay') continue;
    let coilPins = comp.pins.filter(p => /COIL/i.test(p.name || ''));
    if (!coilPins.length && comp.pins.length === 2) coilPins = comp.pins;
    const coilNets = [...new Set(coilPins.map(p => p.net).filter(Boolean))];
    if (coilNets.length !== 2) continue;
    const diode = findDiodeAcross(model, coilNets[0], coilNets[1]);
    if (!diode) continue;
    const anode = pinByName(diode, /^A\d*$/);
    const cathode = pinByName(diode, /^K\d*$/);
    if (!anode || !cathode || !anode.net || !cathode.net) continue;
    const powerNet = coilNets.find(n => isPowerNetName(n));
    if (!powerNet) continue;
    if (anode.net === powerNet) {
      push(mkFinding('R039', 'P1', 'high', 'component', { designator: comp.designator },
        [pinEvidence(comp, coilPins[0]), pinEvidence(diode, anode), pinEvidence(diode, cathode)],
        { designators: [comp.designator, diode.designator], uids: [comp.uid, diode.uid], nets: coilNets }));
    }
  }

  // R029 power/ground net conflicts and rail shorts.
  for (const net of model.nets) {
    const pins = [];
    for (const comp of model.components) {
      for (const pin of comp.pins) {
        if (pin.net !== net.name) continue;
        const cls = classifyPinName(pin.name, pin.pinType);
        if (cls.isPower || cls.isGround) pins.push({ comp, pin, cls });
      }
    }
    const hasPower = pins.some(p => p.cls.isPower);
    const hasGround = pins.some(p => p.cls.isGround);
    if (hasPower && hasGround) {
      push(mkFinding('R029', 'P0', 'high', 'power', { net: net.name },
        pins.filter(p => p.cls.isPower || p.cls.isGround).map(p => pinEvidence(p.comp, p.pin)),
        { designators: pins.map(p => p.comp.designator), uids: pins.map(p => p.comp.uid), nets: [net.name] }));
    }
  }
  for (const comp of model.components) {
    if (comp.pins.length !== 2) continue;
    const value = String(comp.rawValue ?? comp.displayValue ?? '').trim();
    const isZero = isZeroOhmValue(value) || /jumper|跳线|short/i.test(value);
    if (!isZero) continue;
    const nets = componentNets(comp);
    if (nets.length !== 2) continue;
    if (nets.every(n => isPowerNetName(n)) && nets[0] !== nets[1]) {
      push(mkFinding('R029', 'P0', 'high', 'power', { net: `${nets[0]} / ${nets[1]}` },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator, property: 'Value', value },
          ...nets.map(n => ({ kind: 'net', net: n, pins: [] }))],
        { designators: [comp.designator], uids: [comp.uid], nets }));
    }
  }

  // R040 isolated ground nets (no DC tie back to another ground).
  const groundNets = model.nets.filter(n => n.isGround && n.pinCount > 0 &&
    !/^(EARTH|CHASSIS|FG)([_-]|$)/i.test(n.name));
  if (groundNets.length >= 2) {
    const groundNames = groundNets.map(n => n.name);
    for (const net of groundNets) {
      if (r040GroundTie(model, net.name, groundNames.filter(g => g !== net.name))) continue;
      push(mkFinding('R040', 'P2', 'medium', 'power', { net: net.name },
        [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R041 UART TX-TX / RX-RX same-direction connection.
  const UART_TX_RE = /(^|[_-])(TX|TXD|TXO)\d*$/i;
  const UART_RX_RE = /(^|[_-])(RX|RXD|RXI)\d*$/i;
  for (const net of model.nets) {
    const tx = [], rx = [];
    for (const comp of model.components) {
      // 连接器/测试点引脚名通常标注信号名而非方向，不参与判定。
      if (['connector', 'testpoint'].includes(comp.category)) continue;
      for (const pin of comp.pins) {
        if (pin.net !== net.name) continue;
        const name = String(pin.name || '').trim();
        if (UART_TX_RE.test(name)) tx.push({ comp, pin });
        else if (UART_RX_RE.test(name)) rx.push({ comp, pin });
      }
    }
    const sameDir = tx.length >= 2 && rx.length === 0 ? { dir: 'TX', pins: tx }
      : rx.length >= 2 && tx.length === 0 ? { dir: 'RX', pins: rx } : null;
    if (!sameDir) continue;
    push(mkFinding('R041', 'P1', 'medium', 'interface', { net: net.name, dir: sameDir.dir },
      sameDir.pins.map(p => pinEvidence(p.comp, p.pin)),
      { designators: sameDir.pins.map(p => p.comp.designator), uids: sameDir.pins.map(p => p.comp.uid), nets: [net.name] }));
  }

  // R042 regulator input capacitor missing.
  for (const comp of model.components) {
    if (comp.category !== 'regulator') continue;
    for (const inp of pinsByName(comp, /^(IN|VIN|VI)\d*$/)) {
      if (!inp.net || isGroundNetName(inp.net)) continue;
      if (findCapToGroundOneHop(model, inp.net)) continue;
      push(mkFinding('R042', 'P2', 'medium', 'power',
        { designator: comp.designator, pin: inp.number, net: inp.net },
        [pinEvidence(comp, inp)], { designators: [comp.designator], uids: [comp.uid], nets: [inp.net] },
        { _subjects: [`pin:${comp.uid}:${inp.number}`] }));
    }
  }

  // R043 optocoupler input series resistor missing.
  for (const comp of model.components) {
    if (comp.category !== 'optocoupler') continue;
    const anode = pinByName(comp, /^(A|AN|ANODE|\+)$/);
    const cathode = pinByName(comp, /^(K|CATH|CATHODE|-)$/);
    if (anode && cathode) {
      const nets = [...new Set([anode.net, cathode.net].filter(Boolean))].filter(n => !isGroundNetName(n));
      if (!nets.length) continue;
      if (!nets.some(n => findSeriesResistor(model, n))) {
        push(mkFinding('R043', 'P2', 'medium', 'component', { designator: comp.designator },
          [pinEvidence(comp, anode), pinEvidence(comp, cathode)],
          { designators: [comp.designator], uids: [comp.uid], nets }));
      }
    } else if (comp.pins.length === 4) {
      // 常见 4 脚光耦（如 PC817）1/2 脚为输入侧；引脚名为数字时只能按常见引脚排列推测。
      const p1 = comp.pins.find(p => String(p.number) === '1');
      const p2 = comp.pins.find(p => String(p.number) === '2');
      if (!p1?.net || !p2?.net || p1.net === p2.net) continue;
      const nets = [p1.net, p2.net].filter(n => !isGroundNetName(n));
      if (!nets.length || nets.some(n => findSeriesResistor(model, n))) continue;
      openQuestions.push({
        question: `光耦 ${comp.designator} 的 1/2 脚推定为输入侧，未发现限流电阻，请确认。`,
        related: [comp.designator],
        why: '引脚名为数字，输入侧按常见 4 脚光耦引脚排列推测，需数据手册确认。',
      });
    }
  }

  // R044 CAN / RS-485 bus termination missing (strict).
  if (strict) {
    const byNorm = new Map(model.nets.map(n => [n.name.toUpperCase().replace(/[_-]/g, ''), n.name]));
    const seenPairs = new Set();
    for (const [norm, name] of byNorm) {
      for (const [a, b] of [['CANH', 'CANL'], ['CANP', 'CANN'], ['485A', '485B']]) {
        if (!norm.endsWith(a)) continue;
        const other = byNorm.get(norm.slice(0, -a.length) + b);
        if (!other) continue;
        const key = [name, other].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        if (findResistorBetween(model, name, other)) continue;
        push(mkFinding('R044', 'P3', 'low', 'interface', { netA: name, netB: other },
          [{ kind: 'net', net: name, pins: [] }, { kind: 'net', net: other, pins: [] }],
          { nets: [name, other] }));
      }
    }
  }

  // R045 SWD debug pair incomplete (strict).
  if (strict) {
    const swdio = model.nets.filter(n => /(^|[_-])SWDIO\d*([_-]|$)/i.test(n.name));
    const swclk = model.nets.filter(n => /(^|[_-])SWCLK\d*([_-]|$)/i.test(n.name));
    const missing = swdio.length && !swclk.length ? swdio : swclk.length && !swdio.length ? swclk : [];
    for (const net of missing) {
      push(mkFinding('R045', 'P3', 'low', 'interface', { net: net.name },
        [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R046 reset pin tied to a fixed rail (held active / never active).
  for (const comp of model.components) {
    if (comp.dnp === true) continue;
    if (['connector', 'testpoint', 'mechanical'].includes(comp.category)) continue;
    for (const pin of comp.pins) {
      if (!pin.net || !pinNameSegments(pin.name).some(s => RESET_PIN_RE.test(s))) continue;
      const toGround = isGroundNetName(pin.net);
      const toPower = !toGround && isPowerNetName(pin.net);
      if (!toGround && !toPower) continue;
      push(mkFinding('R046', toGround ? 'P0' : 'P1', 'medium', 'interface',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—', net: pin.net, rail: toGround ? 'GND' : 'POWER' },
        [pinEvidence(comp, pin), netEvidence(model.nets.find(n => n.name === pin.net) || { name: pin.net, pins: [] })],
        { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R047 multiple power outputs directly paralleled on one rail.
  const POWER_OUTPUT_PIN_RE = /^(VOUT|VO\d*|V3|VCORE_OUT|\d+(\.\d+)?VOUT|3V3OUT|5VOUT)$/i;
  for (const net of model.nets) {
    if (!net.isPower || net.isGround || net.powerKind === 'reference') continue;
    const sources = [];
    for (const comp of findComponentsTouching(model, net.name)) {
      if (comp.dnp === true) continue;
      if (['connector', 'testpoint'].includes(comp.category)) continue;
      if (comp.pins.some(p => p.net === net.name && pinNameSegments(p.name).some(s => POWER_OUTPUT_PIN_RE.test(s)))) sources.push(comp);
    }
    if (sources.length < 2) continue;
    push(mkFinding('R047', 'P1', 'medium', 'power',
      { net: net.name, designators: sources.map(c => c.designator).join(', ') },
      [...sources.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator })), netEvidence(net)],
      { designators: sources.map(c => c.designator), uids: sources.map(c => c.uid), nets: [net.name] }));
  }

  // R048 USB-C CC1/CC2 missing Rp/Rd (or floating).
  for (const comp of model.components) {
    if (comp.dnp === true) continue;
    const cc1 = pinByName(comp, /^CC1$/);
    const cc2 = pinByName(comp, /^CC2$/);
    if (!cc1 || !cc2) continue;
    for (const pin of [cc1, cc2]) {
      const floating = !pin.net;
      const hasRp = !floating && findResistorToPower(model, pin.net);
      const hasRd = !floating && findResistorToGround(model, pin.net);
      if (!floating && (hasRp || hasRd)) continue;
      push(mkFinding('R048', 'P1', 'medium', 'interface',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—', state: floating ? 'floating' : 'no-resistor' },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: pin.net ? [pin.net] : [] },
        { _subjects: [`pin:${comp.uid}:${pin.number}`] }));
    }
  }

  // R049 MCU core-regulator pin (VCL/VCAP/VCORE/VDDCORE) needs a local storage cap, not a connector.
  const CORE_CAP_PIN_RE = /^(VCL|VCAP\d*|VCORE|VDDCORE|VREG)$/i;
  for (const comp of model.components) {
    if (comp.dnp === true) continue;
    if (!['ic', 'regulator'].includes(comp.category)) continue;
    for (const pin of pinsByName(comp, CORE_CAP_PIN_RE)) {
      if (!pin.net || isGroundNetName(pin.net)) continue;
      const hasCap = Boolean(findCapToGround(model, pin.net));
      const toConnector = findComponentsTouching(model, pin.net).some(c => c.uid !== comp.uid && c.category === 'connector');
      if (hasCap && !toConnector) continue;
      push(mkFinding('R049', 'P1', 'medium', 'power',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—', net: pin.net },
        [pinEvidence(comp, pin), netEvidence(model.nets.find(n => n.name === pin.net) || { name: pin.net, pins: [] })],
        { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] }));
    }
  }

  // R050 one supplier/manufacturer part used with multiple different values.
  {
    const normVal = v => String(v ?? '').trim().toLowerCase().replace(/µ/g, 'u').replace(/\s+/g, '');
    const groups = new Map();
    const add = (part, value, designator) => {
      const p = String(part ?? '').trim();
      const v = normVal(value);
      if (!p || !v || isPlaceholderValue(v) || PACKAGE_CODE_RE.test(v) || !designator) return;
      if (!groups.has(p)) groups.set(p, { values: new Map(), designators: new Set() });
      const g = groups.get(p);
      if (!g.values.has(v)) g.values.set(v, String(value).trim());
      g.designators.add(designator);
    };
    for (const comp of model.components) {
      if (!comp.addIntoBom || comp.dnp === true) continue;
      const value = comp.rawValue ?? comp.displayValue;
      add(comp.supplierPart, value, comp.designator);
      add(comp.manufacturerPart, value, comp.designator);
    }
    if (bom.available) {
      for (const row of bom.rows) {
        for (const d of row.designators) add(row.supplierPart, row.value, d);
      }
    }
    const seenSets = new Set();
    for (const [part, g] of groups) {
      if (g.values.size < 2) continue;
      const setKey = [...g.designators].sort().join('|');
      if (seenSets.has(setKey)) continue;
      seenSets.add(setKey);
      const designators = [...g.designators].sort();
      const comps = designators.map(d => model.components.find(c => c.designator === d)).filter(Boolean);
      push(mkFinding('R050', 'P1', 'medium', 'bom',
        { part, values: [...g.values.values()].join(' / '), designators: designators.join(', ') },
        [{ kind: 'bom', designators, detail: `${part}: ${[...g.values.values()].join(' / ')}` },
          ...comps.map(c => ({ kind: 'component', uid: c.uid, designator: c.designator }))],
        { designators, uids: comps.map(c => c.uid) }));
    }
  }

  // R051 power-select header/jumper without a defined default state.
  for (const comp of model.components) {
    if (comp.dnp === true) continue;
    if (!['connector', 'ic', 'other'].includes(comp.category)) continue;
    if (comp.pins.length < 2 || comp.pins.length > 3) continue;
    const nets = comp.pins.map(p => p.net);
    if (!nets.every(n => n && isPowerNetName(n) && !isGroundNetName(n))) continue;
    const distinct = [...new Set(nets)];
    if (distinct.length < 2) continue;
    push(mkFinding('R051', 'P2', 'medium', 'power',
      { designator: comp.designator, nets: distinct.join(' / ') },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...comp.pins.map(p => pinEvidence(comp, p))],
      { designators: [comp.designator], uids: [comp.uid], nets: distinct }));
  }

  // R052 reference pin (VREFH/VREFL/VREF±) without decoupling/reference source.
  const VREF_PIN_RE = /^(VREF[+-]?[HLPN]?)(\d+)?$/i;
  for (const comp of model.components) {
    if (comp.dnp === true) continue;
    if (!['ic', 'regulator'].includes(comp.category)) continue;
    for (const pin of pinsByName(comp, VREF_PIN_RE)) {
      if (!pin.net || isGroundNetName(pin.net)) continue;
      if (findCapToGround(model, pin.net)) continue;
      push(mkFinding('R052', 'P2', 'medium', 'power',
        { designator: comp.designator, pin: pin.number, pinName: pin.name || '—', net: pin.net },
        [pinEvidence(comp, pin)], { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] }));
    }
  }

  // R053 per-IC decoupling cap count below power-pin count (strict).
  if (strict) {
    for (const comp of model.components) {
      if (!['ic', 'regulator'].includes(comp.category)) continue;
      const powerPins = comp.pins.filter(p => {
        if (!p.net) return false;
        const cls = classifyPinName(p.name, p.pinType);
        return cls.isPower && !cls.isGround && cls.kind !== 'reference';
      });
      if (powerPins.length < 2) continue;
      const rails = new Set(powerPins.map(p => p.net));
      const caps = new Set();
      for (const rail of rails) {
        for (const c of model.components) {
          if (c.category !== 'capacitor' || !hasPinOnNet(c, rail)) continue;
          const other = otherPinNet(c, rail);
          if (other && isGroundNetName(other)) caps.add(c.uid);
        }
      }
      if (caps.size < powerPins.length) {
        push(mkFinding('R053', 'P3', 'low', 'power',
          { designator: comp.designator, pins: powerPins.length, caps: caps.size },
          [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...powerPins.map(p => pinEvidence(comp, p))],
          { designators: [comp.designator], uids: [comp.uid], nets: [...rails] }));
      }
    }
  }

  // R054 external connector data lines without ESD/TVS protection.
  {
    const DATA_NET_RE = /(^|[_-])(DP|DM|DN|D\+|D-|USB|CANH|CANL|CANP|CANN|485A|485B|ETH|TXP|TXN|RXP|RXN)(\d*|$)/i;
    const seenNets = new Set();
    for (const comp of model.components) {
      if (comp.category !== 'connector') continue;
      for (const pin of comp.pins) {
        if (!pin.net || seenNets.has(pin.net)) continue;
        if (isPowerNetName(pin.net) || isGroundNetName(pin.net)) continue;
        if (!DATA_NET_RE.test(pin.net)) continue;
        seenNets.add(pin.net);
        const touching = findComponentsTouching(model, pin.net);
        const hasEsd = touching.some(c => c.category === 'tvs' ||
          /\bESD\b|\bTVS\b|静电保护|瞬态抑制/i.test(`${c.description || ''} ${c.name || ''}`));
        if (hasEsd) continue;
        push(mkFinding('R054', 'P2', 'medium', 'interface',
          { net: pin.net, designator: comp.designator },
          [pinEvidence(comp, pin), netEvidence(model.nets.find(n => n.name === pin.net) || { name: pin.net, pins: [] })],
          { designators: [comp.designator], uids: [comp.uid], nets: [pin.net] }));
      }
    }
  }

  // R055 cross-power-domain direct connection without level shifting (strict).
  if (strict) {
    const domainOf = (comp) => {
      const volts = new Map();
      for (const p of comp.pins) {
        if (!p.net) continue;
        const cls = classifyPinName(p.name, p.pinType);
        if (!cls.isPower || cls.isGround || cls.kind === 'reference') continue;
        const v = parseRailVoltage(p.net);
        if (v != null) volts.set(v, (volts.get(v) || 0) + 1);
      }
      if (!volts.size) return null;
      const sorted = [...volts.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null; // 多域器件，域不确定
      return sorted[0][0];
    };
    for (const net of model.nets) {
      if (net.isPower || net.isGround || net.isAuto || net.pinCount < 2) continue;
      if (countResistorsOn(model, net.name) > 0) continue; // 可能是分压/限流电平转换
      const domains = new Map();
      for (const comp of findComponentsTouching(model, net.name)) {
        if (!['ic', 'regulator'].includes(comp.category)) continue;
        const v = domainOf(comp);
        if (v != null) domains.set(v, comp.designator);
      }
      if (domains.size < 2) continue;
      push(mkFinding('R055', 'P2', 'low', 'interface',
        { net: net.name, voltages: [...domains.keys()].map(v => `${v}V`).join(' / ') },
        [netEvidence(net)], { nets: [net.name] }));
    }
  }

  // R056 LED series current estimated outside 0.5–20 mA bounds.
  for (const comp of model.components) {
    if (comp.category !== 'led' || comp.dnp === true) continue;
    const nets = componentNets(comp);
    // 供电电压：LED 直连的电源轨，或驱动 IC 的主电源域（GPIO 驱动场景）。
    let v = null;
    let railNet = nets.find(n => isPowerNetName(n) && parseRailVoltage(n) != null);
    if (railNet) {
      v = parseRailVoltage(railNet);
    } else {
      for (const n of nets) {
        if (isGroundNetName(n)) continue;
        for (const c of findComponentsTouching(model, n)) {
          if (!['ic', 'regulator'].includes(c.category) || c.uid === comp.uid) continue;
          const volts = c.pins.map(p => p.net).filter(Boolean)
            .map(pn => parseRailVoltage(pn)).filter(x => x != null);
          if (volts.length) { v = volts[0]; railNet = n; break; }
        }
        if (v != null) break;
      }
    }
    if (v == null) continue; // 电源域不可解析（如跳线可选 VCC）时不做估算
    const resistor = nets.map(n => findSeriesResistor(model, n)).find(Boolean);
    if (!resistor) continue; // 缺电阻由 R013 负责
    const ohms = [resistor.rawValue, resistor.name, resistor.displayValue]
      .map(x => parseResistance(x)).find(x => x != null && x > 0);
    if (!ohms) continue;
    const iMax = (v - 1.8) / ohms; // Vf 下限 1.8V（红/黄）
    const iMin = Math.max(0, (v - 3.3) / ohms); // Vf 上限 3.3V（蓝/白）
    if (iMax >= 0.0005 && iMin <= 0.02) continue;
    push(mkFinding('R056', 'P3', 'medium', 'component',
      { designator: comp.designator, resistor: resistor.designator, net: railNet, current: iMax < 0.0005 ? `<0.5mA（估算 ${(iMax * 1000).toFixed(2)}mA）` : `>20mA（估算 ${(iMin * 1000).toFixed(1)}mA）` },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator },
        { kind: 'component', uid: resistor.uid, designator: resistor.designator, property: 'Value', value: resistor.rawValue ?? resistor.name ?? resistor.displayValue }],
      { designators: [comp.designator, resistor.designator], uids: [comp.uid, resistor.uid], nets: [railNet] }));
  }

  // R058 crystal nodes also routed to a connector/header (parasitic capacitance).
  for (const comp of model.components) {
    if (comp.category !== 'crystal') continue;
    if (comp.pins.some(p => classifyPinName(p.name, p.pinType).isPower)) continue; // 有源振荡器跳过
    const bad = componentNets(comp).filter(n => !isGroundNetName(n) && !isPowerNetName(n) &&
      findComponentsTouching(model, n).some(c => c.uid !== comp.uid && c.category === 'connector'));
    if (!bad.length) continue;
    push(mkFinding('R058', 'P3', 'medium', 'component',
      { designator: comp.designator, nets: bad.join(', ') },
      [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...bad.map(n => ({ kind: 'net', net: n, pins: [] }))],
      { designators: [comp.designator], uids: [comp.uid], nets: bad }));
  }

  // R060 connector pins on non-semantic auto net names (strict, readability).
  if (strict) {
    for (const comp of model.components) {
      if (comp.category !== 'connector') continue;
      const autoPins = comp.pins.filter(p => p.net && !isPowerNetName(p.net) && !isGroundNetName(p.net) &&
        (p.net.startsWith('$') || /^[A-Z]{1,3}\d{3,}$/i.test(p.net)));
      if (autoPins.length < 2) continue;
      push(mkFinding('R060', 'P3', 'low', 'readability',
        { designator: comp.designator, count: autoPins.length, sample: [...new Set(autoPins.map(p => p.net))].slice(0, 3).join(', ') },
        [{ kind: 'component', uid: comp.uid, designator: comp.designator }, ...autoPins.slice(0, 5).map(p => pinEvidence(comp, p))],
        { designators: [comp.designator], uids: [comp.uid], nets: [...new Set(autoPins.map(p => p.net))] }));
    }
  }

  // R059（开放问题，非编号规则）：SWD 排针无统一标准线序，只能提示人工核对。
  for (const comp of model.components) {
    if (comp.category !== 'connector') continue;
    const nets = comp.pins.map(p => p.net).filter(Boolean);
    const hasSwdio = nets.some(n => /(^|[_-])SWDIO\d*([_-]|$)/i.test(n));
    const hasSwclk = nets.some(n => /(^|[_-])SWCLK\d*([_-]|$)/i.test(n));
    if (hasSwdio && hasSwclk) {
      openQuestions.push({
        question: `调试排针 ${comp.designator} 含 SWDIO/SWCLK，请核对线序与调试器一致（SWD 排针无统一标准线序）。`,
        related: [comp.designator],
        why: '线序接反可能损坏调试器或目标板，但网表无法证明线序对错。',
      });
    }
  }

  // Suppression: pinned order per PRD.
  const scopedFindings = findings.filter(f => enabled.has(f.ruleId));
  const suppressed = suppressFindings(scopedFindings);
  const deduped = [];
  const seenKeys = new Set();
  for (const f of scopedFindings.filter(x => !x._suppressed)) {
    const key = `${f.ruleId}|${JSON.stringify(f.params || {})}|${JSON.stringify(f.location?.uids || [])}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(f);
  }
  const finalFindings = deduped;

  // Attach page names from model.geometry so the report can show which page a finding is on.
  const compByUid = new Map(model.components.map(c => [c.uid, c]));
  const compsByDesignator = new Map();
  for (const c of model.components) {
    if (!c.designator) continue;
    if (!compsByDesignator.has(c.designator)) compsByDesignator.set(c.designator, []);
    compsByDesignator.get(c.designator).push(c);
  }
  const drcPageByPrimitiveId = new Map();
  for (const page of Object.values(model.geometry?.pages || {})) {
    for (const primitiveId of Object.keys(page.drcPrimitives || {})) {
      if (!drcPageByPrimitiveId.has(primitiveId)) drcPageByPrimitiveId.set(primitiveId, pageLabelOf(page) || page.pageName || null);
    }
  }
  for (const f of finalFindings) {
    if ((f.location.pages || []).length) continue;
    const pageNames = new Set();
    for (const uid of f.location.uids) {
      const comp = compByUid.get(uid);
      if (comp?.page) pageNames.add(comp.page);
    }
    if (!pageNames.size) {
      for (const designator of f.location.designators) {
        for (const comp of compsByDesignator.get(designator) || []) {
          if (comp.page) pageNames.add(comp.page);
        }
      }
    }
    if (!pageNames.size) {
      for (const e of f.evidence || []) {
        if (e.kind !== 'drc' || !e.primitiveId) continue;
        const pageName = drcPageByPrimitiveId.get(e.primitiveId);
        if (pageName) pageNames.add(pageName);
      }
    }
    f.location.pages = [...pageNames];
  }
  finalFindings.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const d = (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    if (d) return d;
    return a.ruleId.localeCompare(b.ruleId);
  });
  finalFindings.forEach((f, i) => {
    f.id = `F-${String(i + 1).padStart(3, '0')}`;
    f.findingKey = computeFindingKey(f);
  });

  const maxQuestions = options.maxQuestions ?? 15;
  const allQuestions = dedupeQuestions(openQuestions);
  const result = {
    schemaVersion: '1.0',
    mode,
    findings: finalFindings.map(stripInternal),
    openQuestions: Number.isFinite(maxQuestions) ? allQuestions.slice(0, maxQuestions) : allQuestions,
    coverage: {
      skippedRules,
      suppressedFindings: suppressed,
      rulesEvaluated: [...new Set(finalFindings.map(f => f.ruleId))].sort(),
    },
  };
  return result;
}

function suppressFindings(findings) {
  const pinGroup = ['R046', 'R048', 'R006', 'R015', 'R011', 'R027', 'R028', 'R034', 'R036', 'R042', 'R008', 'R010', 'R002'];
  const netGroup = ['R005', 'R004', 'R001'];
  let count = 0;
  for (const group of [pinGroup, netGroup]) {
    const claimed = new Map();
    const sorted = [...findings].sort((a, b) => group.indexOf(a.ruleId) - group.indexOf(b.ruleId));
    for (const f of sorted) {
      if (!group.includes(f.ruleId)) continue;
      const subjects = f._subjects || [];
      if (subjects.length && subjects.some(s => claimed.has(s))) {
        f._suppressed = true;
        count++;
      } else {
        for (const s of subjects) claimed.set(s, f.ruleId);
      }
    }
  }
  return count;
}

function stripInternal(f) {
  const { _subjects, _suppressed, ...rest } = f;
  return rest;
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter(q => {
    const key = q.question;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function lintFile(modelFile, options = {}) {
  const model = readJson(modelFile);
  return lintModel(model, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('用法: node lint.mjs <model.json> [lint.json] [--mode standard|strict] [--bom bom.csv]');
    process.exit(3);
  }
  const modelFile = args[0];
  const out = args[1] && !args[1].startsWith('--') ? args[1] : null;
  const modeIdx = args.indexOf('--mode');
  const bomIdx = args.indexOf('--bom');
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'standard';
  const bomFile = bomIdx >= 0 ? args[bomIdx + 1] : null;
  try {
    const result = lintFile(modelFile, { mode, bomFile });
    if (out) {
      writeJson(out, result);
      console.log(`lint written: ${out} (${result.findings.length} findings, ${result.coverage.suppressedFindings} suppressed)`);
    } else process.stdout.write(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(4);
  }
}
