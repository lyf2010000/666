/**
 * Component / net classification heuristics.
 * All decisions are explainable: every result carries a basis and confidence.
 */

const CATEGORY_VALUES = new Set([
  'ic', 'regulator', 'connector', 'led', 'crystal', 'capacitor', 'resistor',
  'resistor_array', 'inductor', 'ferrite', 'diode', 'transistor', 'mosfet',
  'fuse', 'tvs', 'switch', 'relay', 'optocoupler', 'buzzer', 'speaker',
  'antenna', 'power_source', 'testpoint', 'mechanical', 'other',
]);

const EXPLICIT_MAP = {
  ic: ['ic', 'integrated circuit', 'mcu', 'soc', 'fpga', 'logic', '集成电路', '芯片', '单片机'],
  regulator: ['regulator', 'ldo', 'dc-dc', 'dcdc', 'voltage regulator', '稳压器', '电源芯片'],
  connector: ['connector', 'header', 'terminal block', '连接器', '端子', '排针', '插座'],
  led: ['led', 'light emitting diode', '发光二极管', '指示灯'],
  crystal: ['crystal', 'oscillator', 'resonator', '晶振', '晶体', '谐振器'],
  capacitor: ['capacitor', 'cap', 'mlcc', 'electrolytic', '电容'],
  resistor: ['resistor', 'res', 'ohm', '电阻'],
  resistor_array: ['resistor array', 'resistor network', '排阻', '电阻排'],
  inductor: ['inductor', 'inductance', '电感'],
  ferrite: ['ferrite bead', 'ferrite', '磁珠'],
  diode: ['diode', 'rectifier', 'schottky', 'zener', '二极管', '整流'],
  transistor: ['transistor', 'bjt', '三极管', '晶体管'],
  mosfet: ['mosfet', 'nmos', 'pmos', '场效应管'],
  fuse: ['fuse', 'ptc', 'pptc', '保险丝', '自恢复保险丝'],
  tvs: ['tvs', 'esd', '瞬态抑制', '静电保护'],
  switch: ['switch', 'button', 'key', '开关', '按键'],
  relay: ['relay', '继电器'],
  optocoupler: ['optocoupler', 'opto-isolator', 'optocoupler', '光耦', '光隔离'],
  buzzer: ['buzzer', '蜂鸣器'],
  speaker: ['speaker', '扬声器', '喇叭'],
  antenna: ['antenna', '天线'],
  power_source: ['battery', 'battery holder', '电池', '电池座'],
  testpoint: ['test point', 'testpoint', '测试点'],
  mechanical: ['mechanical', 'mounting hole', 'fiducial', '结构件', '安装孔', '基准点'],
};

// Longest prefixes first. A prefix must be followed by a digit or end-of-designator.
const PREFIX_RULES = [
  ['LED', 'led', 'high'],
  ['D_LED', 'led', 'high'],
  ['FUSE', 'fuse', 'high'],
  ['PTC', 'fuse', 'high'],
  ['TVS', 'tvs', 'high'],
  ['TEST', 'testpoint', 'high'],
  ['CON', 'connector', 'medium'],
  ['HDR', 'connector', 'medium'],
  ['USB', 'connector', 'medium'],
  ['RLY', 'relay', 'low'],
  ['SPK', 'speaker', 'medium'],
  ['BZ', 'buzzer', 'medium'],
  ['LS', 'speaker', 'medium'],
  ['ANT', 'antenna', 'medium'],
  ['OPT', 'optocoupler', 'medium'],
  ['OC', 'optocoupler', 'medium'],
  ['PC', 'optocoupler', 'medium'],
  ['XTAL', 'crystal', 'high'],
  ['OSC', 'crystal', 'high'],
  ['CRY', 'crystal', 'high'],
  ['VR', 'regulator', 'medium'],
  ['REG', 'regulator', 'medium'],
  ['LDO', 'regulator', 'medium'],
  ['DCDC', 'regulator', 'medium'],
  ['IC', 'ic', 'medium'],
  ['MCU', 'ic', 'medium'],
  ['SOC', 'ic', 'medium'],
  ['FPGA', 'ic', 'medium'],
  ['RN', 'resistor_array', 'high'],
  ['RP', 'resistor_array', 'high'],
  ['FB', 'ferrite', 'medium'],
  ['BD', 'ferrite', 'medium'],
  ['BT', 'power_source', 'high'],
  ['BAT', 'power_source', 'high'],
  ['TP', 'testpoint', 'high'],
  ['MH', 'mechanical', 'medium'],
  ['MTG', 'mechanical', 'medium'],
  ['U', 'ic', 'medium'],
  ['R', 'resistor', 'high'],
  ['C', 'capacitor', 'high'],
  ['L', 'inductor', 'high'],
  ['D', 'diode', 'medium'],
  ['VD', 'diode', 'medium'],
  ['Q', 'transistor', 'medium'],
  ['VT', 'transistor', 'medium'],
  ['J', 'connector', 'medium'],
  ['P', 'connector', 'medium'],
  ['CN', 'connector', 'medium'],
  ['H', 'mechanical', 'medium'],
  ['Y', 'crystal', 'high'],
  ['X', 'crystal', 'high'],
  ['F', 'fuse', 'high'],
  ['FU', 'fuse', 'high'],
  ['K', 'relay', 'low'],
  ['SW', 'switch', 'medium'],
  ['KEY', 'switch', 'medium'],
  ['BTN', 'switch', 'medium'],
  ['Z', 'crystal', 'high'],
  ['E', 'antenna', 'low'],
];

const PREFIX_BY_LEN = [...PREFIX_RULES].sort((a, b) => b[0].length - a[0].length);

const DESCRIPTION_RULES = [
  [/\boptocoupler\b|\bopto[- ]isolator\b/i, 'optocoupler'],
  [/ferrite\s*bead|\bfb\b|磁珠/i, 'ferrite'],
  [/resistor\s*(array|network)|排阻|电阻排/i, 'resistor_array'],
  [/\bmosfet\b|\bnmos\b|\bpmos\b|场效应管/i, 'mosfet'],
  [/\bled\b|light\s*emitting|发光二极管/i, 'led'],
  [/\bzener\b|\bschottky\b|\brectifier\b|二极管|整流/i, 'diode'],
  [/\bcrystal\b|\boscillator\b|\bresonator\b|晶振|谐振器/i, 'crystal'],
  [/\bregulator\b|\bldo\b|\bdc[- ]?dc\b|稳压器/i, 'regulator'],
  [/\b(AMS1117|LM1117|LD1117|AZ1117|NCP1117|LM78\d\d|78M\d\d|78L\d\d|79M\d\d|79L\d\d|LP2985|ME6211|RT9013|TLV7\d{3}|XC6206|HT75\d\d|SGM20\d\d|AP2112|AP7361|MIC5205|SPX3819)\b/i, 'regulator'],
  [/\bconnector\b|\bheader\b|terminal\s*block|连接器|排针|插座|排母|\bHDR\b|HDR[-_](TH|SMD)|\bHEAD\d*\b|\bSIP\d+\b|TYPE-?C\d*PIN/i, 'connector'],
  [/\bcapacitor\b|\bmlcc\b|\belectrolytic\b|电容/i, 'capacitor'],
  [/\bresistor\b|\bohm\b|电阻/i, 'resistor'],
  [/\binductor\b|电感/i, 'inductor'],
  [/\bfuse\b|\bptc\b|保险丝/i, 'fuse'],
  [/\btvs\b|\besd\b|瞬态抑制/i, 'tvs'],
  [/\brelay\b|继电器/i, 'relay'],
  [/\bbuzzer\b|蜂鸣器/i, 'buzzer'],
  [/\bspeaker\b|扬声器|喇叭/i, 'speaker'],
  [/\bantenna\b|天线/i, 'antenna'],
  [/\bbattery\b|电池/i, 'power_source'],
  [/\btest\s*point\b|测试点/i, 'testpoint'],
  [/\bswitch\b|\bbutton\b|开关|按键/i, 'switch'],
  [/\btransistor\b|\bbjt\b|三极管/i, 'transistor'],
  [/\b(mcu|soc|fpga|op[- ]?amp|adc|dac|555|logic)\b|\b(ne555|lm555|na555)\b|集成电路|芯片/i, 'ic'],
];

const PLACEHOLDER_VALUES = new Set(['', '-', '--', '?', 'n/a', 'na', 'n/c', 'nc', 'dnp', 'dni', 'tbd', '待定', '未定', '无']);

export function normalizeValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUES.has(normalizeValue(value));
}

export function extractDesignatorPrefix(designator) {
  const m = String(designator ?? '').trim().match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : '';
}

function explicitCategory(props) {
  const keys = ['Category', '器件类型', 'Component Type', 'Part Type', 'Type'];
  for (const key of keys) {
    if (!props || props[key] == null) continue;
    const raw = normalizeValue(props[key]);
    if (!raw) continue;
    for (const [cat, aliases] of Object.entries(EXPLICIT_MAP)) {
      if (aliases.some(a => raw === a.toLowerCase() || raw.includes(a.toLowerCase()))) {
        return { category: cat, basis: [`property:${key}=${props[key]}`] };
      }
    }
    if (CATEGORY_VALUES.has(raw)) return { category: raw, basis: [`property:${key}=${props[key]}`] };
  }
  return null;
}

function descriptionCategory(text) {
  for (const [re, category] of DESCRIPTION_RULES) {
    if (re.test(text)) return category;
  }
  return null;
}

function prefixCategory(designator) {
  const prefix = extractDesignatorPrefix(designator);
  if (!prefix) return null;
  for (const [p, category, confidence] of PREFIX_BY_LEN) {
    if (prefix === p || (prefix.startsWith(p) && prefix.length > p.length)) {
      return { category, confidence, prefix: p };
    }
  }
  return null;
}

function pinCategory(comp) {
  const pins = comp.pins || [];
  const names = pins.map(p => String(p.name ?? '').toUpperCase());
  if (names.length === 2) {
    if (names.includes('A') && names.includes('K')) return null; // LED/diode ambiguous
    if (names.every(n => /^\d+$/.test(n))) return 'passive2';
  }
  if (names.length >= 6 && names.some(n => /^(VCC|VDD|GND|VSS)$/.test(n))) return 'ic';
  return null;
}

export function classifyComponent(comp) {
  const props = comp.props || {};
  const basis = [];
  const explicit = explicitCategory(props);
  if (explicit) {
    return { category: explicit.category, categoryConfidence: 'high', categoryBasis: explicit.basis };
  }

  const descText = [
    comp.description, comp.name, comp.deviceName, comp.displayValue,
    props.Description, props.Name, props.DeviceName,
  ].filter(Boolean).join(' ');
  const descCat = descriptionCategory(descText);
  const prefix = prefixCategory(comp.designator);

  if (prefix && descCat && prefix.category === descCat) {
    basis.push(`designator:${prefix.prefix}`, `description:${descCat}`);
    return { category: descCat, categoryConfidence: 'high', categoryBasis: basis };
  }
  if (prefix) {
    // U 是通用位号：名称/描述给出具体非 IC 类别（排针 HDR/SIP/HEAD、稳压器 AMS1117 等）时描述优先。
    if (prefix.prefix === 'U' && prefix.category === 'ic' && descCat && descCat !== 'ic') {
      basis.push(`designator:${prefix.prefix}`, `description:${descCat}`);
      return { category: descCat, categoryConfidence: 'medium', categoryBasis: basis };
    }
    basis.push(`designator:${prefix.prefix}`);
    if (descCat) basis.push(`description:${descCat}`);
    return {
      category: prefix.category,
      categoryConfidence: descCat ? 'medium' : prefix.confidence,
      categoryBasis: basis,
    };
  }
  if (descCat) {
    basis.push(`description:${descCat}`);
    return { category: descCat, categoryConfidence: 'medium', categoryBasis: basis };
  }

  const pinCat = pinCategory(comp);
  if (pinCat === 'ic') {
    basis.push(`pins:${(comp.pins || []).length}`, 'pins:power-names');
    return { category: 'ic', categoryConfidence: 'low', categoryBasis: basis };
  }
  if (pinCat === 'passive2') {
    basis.push('pins:2-generic');
    return { category: 'other', categoryConfidence: 'low', categoryBasis: basis };
  }
  basis.push('no-strong-evidence');
  return { category: 'other', categoryConfidence: 'low', categoryBasis: basis };
}

const GROUND_RE = /^(GND|AGND|DGND|PGND|SGND|GNDA|GNDD|VSS|VSSA|0V|EARTH|CHASSIS|FG)([_\-]?\w+)?$/i;
const POWER_RE = /^(VCC|VDD|VBAT|VIN|VBUS|VREF|VPP|AVDD|DVDD|VIO|VDDIO|VDDA|VEE|VSYS|VCORE|VCHG|VOUT|VMOTOR|VLED|VBACK|VBACKUP|PWR|POWER|RAIL)([_\-]?\w+)?$/i;
const VOLTAGE_RE = /^[+\-]?\d+(\.\d+)?(V|V\d+)([_\-][A-Za-z0-9]+)?$/i;
const PREFIXED_POWER_RE = /^\w+_(VCC|VDD|VBAT|VIN|VBUS)$/i;
const V_UNDERSCORE_RE = /^V_\w+$/i;

const EXCLUDE_SUFFIX_TOKENS = new Map([
  ['EN', 'control'], ['ENABLE', 'control'], ['PG', 'control'], ['PGOOD', 'control'],
  ['GOOD', 'control'], ['FAULT', 'control'], ['ALERT', 'control'], ['MON', 'control'],
  ['TEST', 'control'], ['RTN', 'control'], ['CS', 'control'], ['INT', 'control'],
  ['RST', 'control'], ['TRIG', 'control'], ['GATE', 'control'], ['DRV', 'control'],
  ['SW', 'control'], ['CTRL', 'control'], ['STATUS', 'control'], ['SHDN', 'control'],
  ['PD', 'control'], ['DIS', 'control'],
  ['SENSE', 'sense'], ['DET', 'sense'], ['FB', 'feedback'], ['ADC', 'sense'],
  ['OC', 'sense'], ['OVP', 'sense'], ['UVLO', 'sense'],
]);

export function classifyNet(name) {
  const raw = String(name ?? '').trim();
  if (!raw || raw.startsWith('$')) {
    return { isPower: false, isGround: false, powerKind: 'unknown', netClassConfidence: 'low', netClassBasis: ['auto-or-empty'] };
  }
  if (GROUND_RE.test(raw)) {
    return { isPower: false, isGround: true, powerKind: 'ground', netClassConfidence: 'high', netClassBasis: [`ground:${raw}`] };
  }
  if (raw.toUpperCase() === 'V-' || /^V-$/i.test(raw)) {
    return { isPower: true, isGround: false, powerKind: 'negative-rail', netClassConfidence: 'high', netClassBasis: ['power:V-'] };
  }
  const isBasicPower = VOLTAGE_RE.test(raw) || POWER_RE.test(raw) || PREFIXED_POWER_RE.test(raw) || V_UNDERSCORE_RE.test(raw);
  if (!isBasicPower) {
    return { isPower: false, isGround: false, powerKind: 'unknown', netClassConfidence: 'low', netClassBasis: ['not-matched'] };
  }

  const tokens = raw.toUpperCase().split(/[_-]+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (EXCLUDE_SUFFIX_TOKENS.has(last)) {
    return {
      isPower: false, isGround: false, powerKind: EXCLUDE_SUFFIX_TOKENS.get(last),
      netClassConfidence: 'medium', netClassBasis: [`exclude-suffix:${last}`],
    };
  }
  if (/^(VREF|VPP)$/i.test(raw)) {
    return {
      isPower: true, isGround: false, powerKind: 'reference',
      netClassConfidence: 'medium', netClassBasis: ['power:reference'],
    };
  }
  if (/VEE/i.test(raw) || /^-/.test(raw)) {
    return { isPower: true, isGround: false, powerKind: 'negative-rail', netClassConfidence: 'medium', netClassBasis: [`power:${raw}`] };
  }
  return { isPower: true, isGround: false, powerKind: 'rail', netClassConfidence: 'high', netClassBasis: [`power:${raw}`] };
}

const PIN_GROUND_RE = /^(GND|VSS|VSSA|AVSS|AGND|DGND|PGND|SGND|0V)(\d+)?$/i;
const PIN_POWER_RE = /^(VCC|VDD|VBAT|VIN|VBUS|VPP|AVDD|AVCC|DVDD|VIO|VDDIO|VDDA|VEE|PWR|VOUT|VREF[+-]?[HLPN]?)(\d+)?$/i;
const PIN_CONTROL_RE = /^(EN|ENABLE|PG|PGOOD|SENSE|DET|FB|ADC|CS|INT|RST|RESET|NRST|TRIG|GATE|DRV|SW|CTRL|STATUS|SHDN|PD|DIS)(\d+)?$/i;

/** Composite pin names like `P010/VREFH0` carry the functional name in a `/`-separated segment. */
export function pinNameSegments(name) {
  return String(name ?? '').trim().toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
}

export function classifyPinName(name, pinType = '') {
  const raw = String(name ?? '').trim().toUpperCase();
  if (!raw && !pinType) {
    return { kind: 'unknown', isPower: false, isGround: false, confidence: 'low', basis: ['empty-pin-name'] };
  }
  const segments = pinNameSegments(raw);
  for (const seg of segments) {
    if (PIN_GROUND_RE.test(seg)) {
      return { kind: 'ground', isPower: false, isGround: true, confidence: 'high', basis: [`pin:${seg}`] };
    }
  }
  for (const seg of segments) {
    if (PIN_POWER_RE.test(seg)) {
      const kind = /VREF|VPP/.test(seg) ? 'reference' : /VEE/.test(seg) ? 'negative-rail' : 'power';
      return { kind, isPower: true, isGround: false, confidence: 'high', basis: [`pin:${seg}`] };
    }
  }
  for (const seg of segments) {
    if (PIN_CONTROL_RE.test(seg)) {
      return { kind: 'control', isPower: false, isGround: false, confidence: 'medium', basis: [`pin:${seg}`] };
    }
  }
  // Fall back to the net-name classifier for unusual pin names like 3V3/5V.
  const asNet = classifyNet(raw);
  if (asNet.isPower || asNet.isGround) {
    return { kind: asNet.isGround ? 'ground' : 'power', isPower: asNet.isPower, isGround: asNet.isGround, confidence: 'medium', basis: asNet.netClassBasis };
  }
  if (pinType && /power/i.test(pinType) && /input|output/i.test(pinType)) {
    return { kind: 'power', isPower: true, isGround: false, confidence: 'low', basis: [`pinType:${pinType}`] };
  }
  return { kind: 'unknown', isPower: false, isGround: false, confidence: 'low', basis: ['pin-name-unknown'] };
}

export function dnpInfo(props = {}) {
  const truthy = v => /^(yes|true|1|是|y)$/i.test(String(v ?? '').trim());
  const keys = ['DNP', 'DNP (Do Not Populate)', 'Do Not Populate', 'DNI', 'Do Not Install', '不贴', '不焊接', '不安装'];
  for (const key of keys) {
    if (props[key] != null && truthy(props[key])) {
      return { dnp: true, dnpConfidence: 'high', dnpSource: 'property', dnpCandidate: false, basis: `property:${key}` };
    }
  }
  const addIntoBom = props['Add into BOM'] ?? props['AddIntoBom'];
  if (addIntoBom != null && !truthy(addIntoBom)) {
    return { dnp: null, dnpConfidence: 'low', dnpSource: 'addIntoBom', dnpCandidate: true, basis: 'property:Add into BOM=false' };
  }
  return { dnp: null, dnpConfidence: null, dnpSource: null, dnpCandidate: false, basis: null };
}

export function boolProp(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(yes|true|1|是|y)$/i.test(String(value).trim());
}
