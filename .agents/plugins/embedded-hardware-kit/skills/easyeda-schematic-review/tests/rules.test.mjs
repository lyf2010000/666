import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildModel } from '../scripts/parse-netlist.mjs';
import { lintModel } from '../scripts/lint.mjs';
import { classifyNet, classifyPinName, classifyComponent, dnpInfo } from '../scripts/lib/classify-components.mjs';
import { mergeFindings } from '../scripts/merge-findings.mjs';
import { renderReport } from '../scripts/render-html.mjs';
import { captureScreenshots, choosePage } from '../scripts/capture-screenshots.mjs';
import { collectLive } from '../scripts/collect-live.mjs';
import {
  parseCliVersion, versionAtLeast, detectCli, openCliTransport, cliInvoke, runCliJson, CLI_MIN_VERSION,
} from '../scripts/lib/cli-transport.mjs';
import { readJson, writeJson, ensureDir, pageFileKeyOf, pageLabelOf } from '../scripts/lib/util.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'projects', 'ne555.enet');

function loadNe555() {
  return JSON.parse(fs.readFileSync(FIX, 'utf8'));
}

function netlist(components) {
  return { version: '2.0.0', components, designRule: { netRule: {} } };
}

function comp(uid, designator, props, pins) {
  return {
    props: { 'Unique ID': uid, Designator: designator, ...props },
    pinInfoMap: Object.fromEntries(pins.map(([number, name, net]) => [number, { number, name, net }])),
  };
}

test('parses the NE555 fixture', () => {
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  assert.equal(model.stats.components, 5);
  assert.equal(model.stats.nets, 6);
  assert.equal(model.components.find(c => c.designator === 'U1').pins.length, 8);
  assert.equal(model.components.find(c => c.designator === 'U1').category, 'ic');
  assert.ok(model.nets.find(n => n.name === 'VCC').isPower);
  assert.ok(model.nets.find(n => n.name === 'GND').isGround);
});

test('classifies power, ground, control, and reference nets', () => {
  assert.equal(classifyNet('3V3_MCU').isPower, true);
  assert.equal(classifyNet('+5V_USB').isPower, true);
  assert.equal(classifyNet('-5V').powerKind, 'negative-rail');
  assert.equal(classifyNet('VCC_SENSE').isPower, false);
  assert.equal(classifyNet('VCC_ENABLE').isPower, false);
  assert.equal(classifyNet('PWR_GOOD').isPower, false);
  assert.equal(classifyNet('VREF').powerKind, 'reference');
  assert.equal(classifyNet('0V').isGround, true);
  assert.equal(classifyNet('$1N13').isPower, false);
  assert.equal(classifyNet('AGND').isGround, true);
});

test('classifies pin names and DNP', () => {
  assert.equal(classifyPinName('VCC').isPower, true);
  assert.equal(classifyPinName('GND').isGround, true);
  assert.equal(classifyPinName('EN').isPower, false);
  const dnp = dnpInfo({ 'Add into BOM': 'no' });
  assert.equal(dnp.dnp, null);
  assert.equal(dnp.dnpCandidate, true);
  const explicit = dnpInfo({ DNP: 'yes' });
  assert.equal(explicit.dnp, true);
  assert.equal(explicit.dnpSource, 'property');
});

test('R029 reports a power/ground conflict on one net', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'VCC', 'PWR'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'GND', 'PWR']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R029' && f.params.net === 'PWR'));
});

test('R009 reports a missing I2C pull-up', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'SCL', 'SCL'], ['2', 'SDA', 'SDA']]),
    b: comp('b', 'U2', {}, [['1', 'SCL', 'SCL'], ['2', 'SDA', 'SDA']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.filter(f => f.ruleId === 'R009').length >= 1);
});

test('R016 reports empty Value but skips DNP', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' }, [['1', '', 'N1'], ['2', '', 'N2']]),
    b: comp('b', 'R2', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes', DNP: 'yes' }, [['1', '', 'N3'], ['2', '', 'N4']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R1'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R2'));
});

test('R030 reports a MOSFET without gate pull-down', () => {
  const model = buildModel(netlist({
    q: comp('q', 'Q1', { Category: 'mosfet' }, [['1', 'G', 'GATE'], ['2', 'S', 'GND'], ['3', 'D', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R030' && f.params.designator === 'Q1'));
});

test('R031 reports a BJT without base resistor', () => {
  const model = buildModel(netlist({
    q: comp('q', 'Q2', { Category: 'transistor' }, [['1', 'B', 'BASE'], ['2', 'C', 'COL'], ['3', 'E', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R031' && f.params.designator === 'Q2'));
});

test('R032 reports a relay coil without flyback diode', () => {
  const model = buildModel(netlist({
    k: comp('k', 'K1', { Category: 'relay' }, [['1', 'COIL1', 'COIL_A'], ['2', 'COIL2', 'COIL_B']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R032' && f.params.designator === 'K1'));
});

test('R033/R034 report incomplete regulator feedback and floating EN', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U10', { Category: 'regulator' }, [
      ['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'FB', 'FB'], ['4', 'EN', ''],
    ]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R033' && f.params.designator === 'U10'));
  assert.ok(lint.findings.some(f => f.ruleId === 'R034' && f.params.designator === 'U10'));
});

test('R035 reports a two-pin device with both pins on one net', () => {
  const model = buildModel(netlist({
    c: comp('c', 'C9', {}, [['1', '', 'SAME'], ['2', '', 'SAME']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R035' && f.params.designator === 'C9'));
});

test('R036 reports a regulator output without capacitor', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U20', { Category: 'regulator' }, [['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'GND', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R036' && f.params.designator === 'U20'));
});

test('R037 reports an LED with anode tied to ground', () => {
  const model = buildModel(netlist({
    d: comp('d', 'D1', { Category: 'led' }, [['1', 'A', 'GND'], ['2', 'K', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R037' && f.params.designator === 'D1'));
});

test('R038 reports a reversed polarized capacitor', () => {
  const model = buildModel(netlist({
    c: comp('c', 'C10', { Category: 'capacitor' }, [['1', '+', 'GND'], ['2', '-', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R038' && f.params.designator === 'C10'));
});

test('R039 reports a reversed relay flyback diode', () => {
  const model = buildModel(netlist({
    k: comp('k', 'K2', { Category: 'relay' }, [['1', 'COIL1', 'VCC'], ['2', 'COIL2', 'DRV']]),
    d: comp('d', 'D2', { Category: 'diode' }, [['1', 'A', 'VCC'], ['2', 'K', 'DRV']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R039' && f.params.designator === 'K2'));
});

test('merge deduplicates AI findings and computes stable findingKey', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  const lint = lintModel(model, { mode: 'standard' });
  writeJson(path.join(dir, 'lint.json'), lint);
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-U1.json'), {
    findings: [{
      id: 'AI-component-U1-001', severity: 'P2', confidence: 'medium', category: 'component',
      title: 'duplicate of R016',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: [], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
    open_questions: ['需要确认 U1 的 RESET 上拉阻值'],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', mode: 'standard' });
  assert.ok(result.openQuestions.some(q => q.question === '需要确认 U1 的 RESET 上拉阻值'));
  assert.equal(result.findings.filter(f => f.ruleId === 'R016' && f.location.uids.includes('gge1')).length, 1);
  const f = result.findings[0];
  assert.match(f.findingKey, /^R/);
  assert.equal(result.openQuestions.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge rejects AI findings with invalid evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), { findings: [], openQuestions: [], coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-X.json'), {
    findings: [{
      id: 'AI-X', severity: 'P1', confidence: 'high', category: 'component', title: 'bad',
      evidence: [{ kind: 'pin', uid: 'nope', designator: 'U9', pin: '1', net: 'VCC' }],
      location: { pages: [], designators: ['U9'], uids: ['nope'], nets: ['VCC'] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', mode: 'standard' });
  assert.equal(result.coverage.aiRejected.length, 1);
  assert.equal(result.findings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lint attaches page names from geometry', () => {
  const model = buildModel(netlist({
    a: comp('gge1', 'R1', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' }, [['1', '', 'N1'], ['2', '', 'N2']]),
  }), {
    geometry: {
      currentPage: 'P1',
      pages: {
        P1: {
          pageName: 'P1', pageFileKey: 'P1', schematicName: 'Schematic1',
          components: { gge1: { designator: 'R1' } }, designatorIndex: {}, drcPrimitives: {},
        },
      },
    },
  });
  const lint = lintModel(model, { mode: 'quick' });
  const f = lint.findings.find(x => x.ruleId === 'R016');
  assert.deepEqual(f.location.pages, ['Schematic1 / P1']);
  assert.equal(model.components[0].page, 'Schematic1 / P1');
  assert.equal(model.components[0].pageKey, 'P1');
});

test('merge derives page names for AI findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  model.components.find(c => c.uid === 'gge1').page = 'P1';
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), { findings: [], openQuestions: [], coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-U1.json'), {
    findings: [{
      id: 'AI-1', severity: 'P2', confidence: 'medium', category: 'component', title: 't',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: [], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
    open_questions: [],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', mode: 'standard' });
  assert.deepEqual(result.findings[0].location.pages, ['P1']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report shows model, duration, tokens, and page/schematic names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), {
    source: { mode: 'file', project: 'Prj', board: 'B1', schematic: 'Schematic1' },
    geometry: {
      currentPage: 'P1',
      currentSchematic: 'Schematic1',
      pages: {
        P1: {
          pageName: 'P1', pageFileKey: 'P1', schematicName: 'Schematic1',
          components: { gge1: { designator: 'U1' } }, designatorIndex: {}, drcPrimitives: {},
        },
      },
    },
  });
  writeJson(path.join(dir, 'model.json'), model);
  const startedAt = new Date(Date.now() - 90000).toISOString();
  writeJson(path.join(dir, 'review-context.json'), {
    schemaVersion: '1.0', model: 'claude-test-1', startedAt,
    endedAt: new Date().toISOString(), tokens: { input: 1200, output: 300, total: 1500 },
  });
  writeJson(path.join(dir, 'manifest.json'), { runAt: startedAt, model: 'claude-test-1', packets: [] });
  writeJson(path.join(dir, 'findings.final.json'), {
    schemaVersion: '1.0', runId: 'test', skillVersion: '1.0.0', lang: 'zh', mode: 'quick',
    source: model.source, stats: model.stats,
    findings: [{
      id: 'F-001', source: 'rule', ruleId: 'R016', messageKey: 'R016.title', params: { designator: 'U1' },
      severity: 'P2', confidence: 'medium', category: 'component', title: 't',
      observation: '', impact: '', suggestion: '',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: ['P1'], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
    openQuestions: [], coverage: {}, warnings: [],
  });
  const { htmlFile } = renderReport({ outDir: dir, lang: 'zh' });
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert.match(html, /Schematic1 \/ P1/);
  assert.match(html, /claude-test-1/);
  assert.match(html, /Token 消耗/);
  assert.match(html, /1,500/);
  const report = readJson(path.join(dir, 'report.json'));
  assert.equal(report.review.tokens.total, 1500);
  assert.ok(report.review.durationMs >= 85000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R016 emits an open question for DNP candidates (Add into BOM=no)', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R9', { 'Add into BOM': 'no', 'Convert to PCB': 'no' }, [['1', '', 'N1'], ['2', '', 'N2']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(!lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R9'));
  assert.ok(lint.openQuestions.some(q => q.related.includes('R9')));
});

test('missing BOM/PCB flags default to yes and produce a warning', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R1', {}, [['1', '', 'N1'], ['2', '', 'N2']]),
  }));
  const r1 = model.components.find(c => c.designator === 'R1');
  assert.equal(r1.addIntoBom, true);
  assert.equal(r1.convertToPcb, true);
  assert.ok(model.warnings.some(w => w.includes('Add into BOM')));
  const lint = lintModel(model, { mode: 'quick' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R016' && f.params.designator === 'R1'));
});

test('R012 skips ground pads and active oscillators', () => {
  const model = buildModel(netlist({
    y: comp('y', 'Y1', { Category: 'crystal' }, [
      ['1', 'XIN', 'XI'], ['2', 'GND', 'GND'], ['3', 'XOUT', 'XO'], ['4', 'GND', 'GND'],
    ]),
    c1: comp('c1', 'C1', {}, [['1', '', 'XI'], ['2', '', 'GND']]),
    c2: comp('c2', 'C2', {}, [['1', '', 'XO'], ['2', '', 'GND']]),
    osc: comp('osc', 'OSC1', { Category: 'crystal' }, [
      ['1', 'EN', 'VCC'], ['2', 'GND', 'GND'], ['3', 'OUT', 'CLK'], ['4', 'VCC', 'VCC'],
    ]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(!lint.findings.some(f => f.ruleId === 'R012'));
});

test('R009 detects numbered I2C nets with prefixes', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'SCL', 'I2C_SCL0'], ['2', 'SDA', 'MCU_SDA1']]),
    b: comp('b', 'U2', {}, [['1', 'SCL', 'I2C_SCL0'], ['2', 'SDA', 'MCU_SDA1']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const nets = lint.findings.filter(f => f.ruleId === 'R009').map(f => f.params.net);
  assert.ok(nets.includes('I2C_SCL0'));
  assert.ok(nets.includes('MCU_SDA1'));
});

test('R014 detects missing +/- counterpart', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'DP', 'USB_D+'], ['2', 'DM', 'USB_D-']]),
    b: comp('b', 'U2', {}, [['1', 'DP', 'USB_D+']]),
    c: comp('c', 'J1', {}, [['1', 'TX', 'SPARE+']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  const nets = lint.findings.filter(f => f.ruleId === 'R014').map(f => f.params.net);
  assert.ok(nets.includes('SPARE+'));
  assert.ok(!nets.includes('USB_D+'));
});

test('R029/R035 recognize 0R0 and 0.0 jumper values', () => {
  const model = buildModel(netlist({
    r1: comp('r1', 'R1', { Value: '0R0' }, [['1', '', '3V3'], ['2', '', '5V']]),
    r2: comp('r2', 'R2', { Value: '0.0' }, [['1', '', 'SAME'], ['2', '', 'SAME']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R029' && f.severity === 'P0'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R035' && f.params.designator === 'R2'));
});

test('R002 treats _NC/(NC) suffix pin names as NC candidates', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'RF_NC', ''], ['2', 'PA0(NC)', ''], ['3', 'GPIO', '']]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  const floating = lint.findings.filter(f => f.ruleId === 'R002').map(f => f.params.pinName);
  assert.ok(!floating.includes('RF_NC'));
  assert.ok(!floating.includes('PA0(NC)'));
  assert.ok(floating.includes('GPIO'));
  assert.ok(lint.openQuestions.length >= 2);
});

test('R034 checks every enable pin, not just the first', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U1', { Category: 'regulator' }, [
      ['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'EN1', 'CTRL'], ['4', 'EN2', ''],
    ]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const f = lint.findings.find(x => x.ruleId === 'R034');
  assert.ok(f);
  assert.equal(f.params.pin, '4');
});

test('R040 reports an isolated ground net but not a tied one', () => {
  const base = {
    a: comp('a', 'U1', {}, [['1', 'VCC', '3V3'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'VCC', '3V3'], ['2', 'GND', 'AGND']]),
    e: comp('e', 'U3', {}, [['1', 'GND', 'EARTH']]),
  };
  const isolated = lintModel(buildModel(netlist(base)), { mode: 'standard' });
  assert.ok(isolated.findings.some(f => f.ruleId === 'R040' && f.params.net === 'AGND'));
  assert.ok(!isolated.findings.some(f => f.ruleId === 'R040' && f.params.net === 'EARTH'));
  const tied = lintModel(buildModel(netlist({
    ...base,
    r: comp('r', 'R1', { Value: '0' }, [['1', '', 'GND'], ['2', '', 'AGND']]),
  })), { mode: 'standard' });
  assert.ok(!tied.findings.some(f => f.ruleId === 'R040'));
});

test('R041 reports TX-TX but not TX-RX wiring', () => {
  const crossed = lintModel(buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'TX', 'UART_A']]),
    b: comp('b', 'U2', {}, [['1', 'RX', 'UART_A']]),
  })), { mode: 'standard' });
  assert.ok(!crossed.findings.some(f => f.ruleId === 'R041'));
  const straight = lintModel(buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'TXD', 'UART_A']]),
    b: comp('b', 'U2', {}, [['1', 'TXD0', 'UART_A']]),
  })), { mode: 'standard' });
  const f = straight.findings.find(x => x.ruleId === 'R041');
  assert.ok(f);
  assert.equal(f.params.dir, 'TX');
});

test('R042 reports a regulator input without capacitor', () => {
  const bare = lintModel(buildModel(netlist({
    u: comp('u', 'U1', { Category: 'regulator' }, [['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'GND', 'GND']]),
    co: comp('co', 'C1', {}, [['1', '', 'VOUT'], ['2', '', 'GND']]),
  })), { mode: 'standard' });
  assert.ok(bare.findings.some(f => f.ruleId === 'R042' && f.params.designator === 'U1'));
  const decoupled = lintModel(buildModel(netlist({
    u: comp('u', 'U1', { Category: 'regulator' }, [['1', 'IN', 'VIN'], ['2', 'OUT', 'VOUT'], ['3', 'GND', 'GND']]),
    ci: comp('ci', 'C2', {}, [['1', '', 'VIN'], ['2', '', 'GND']]),
  })), { mode: 'standard' });
  assert.ok(!decoupled.findings.some(f => f.ruleId === 'R042'));
});

test('R043 reports an optocoupler input without series resistor', () => {
  const bare = lintModel(buildModel(netlist({
    oc: comp('oc', 'OC1', { Category: 'optocoupler' }, [
      ['1', 'A', 'SIG'], ['2', 'K', 'GND'], ['3', 'E', 'GND'], ['4', 'C', 'OUT'],
    ]),
  })), { mode: 'standard' });
  assert.ok(bare.findings.some(f => f.ruleId === 'R043' && f.params.designator === 'OC1'));
  const limited = lintModel(buildModel(netlist({
    oc: comp('oc', 'OC1', { Category: 'optocoupler' }, [
      ['1', 'A', 'SIG'], ['2', 'K', 'GND'], ['3', 'E', 'GND'], ['4', 'C', 'OUT'],
    ]),
    r: comp('r', 'R1', { Value: '1k' }, [['1', '', 'SIG'], ['2', '', 'DRV']]),
  })), { mode: 'standard' });
  assert.ok(!limited.findings.some(f => f.ruleId === 'R043'));
});

test('R044 reports missing CAN termination in strict mode only', () => {
  const parts = {
    u: comp('u', 'U1', {}, [['1', 'CANH', 'CAN_H'], ['2', 'CANL', 'CAN_L']]),
  };
  const standard = lintModel(buildModel(netlist(parts)), { mode: 'standard' });
  assert.ok(!standard.findings.some(f => f.ruleId === 'R044'));
  const strict = lintModel(buildModel(netlist(parts)), { mode: 'strict' });
  assert.ok(strict.findings.some(f => f.ruleId === 'R044'));
  const terminated = lintModel(buildModel(netlist({
    ...parts,
    r: comp('r', 'R1', { Value: '120' }, [['1', '', 'CAN_H'], ['2', '', 'CAN_L']]),
  })), { mode: 'strict' });
  assert.ok(!terminated.findings.some(f => f.ruleId === 'R044'));
});

test('R045 reports an incomplete SWD pair in strict mode', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U1', {}, [['1', 'SWDIO', 'SWDIO']]),
  }));
  const strict = lintModel(model, { mode: 'strict' });
  assert.ok(strict.findings.some(f => f.ruleId === 'R045' && f.params.net === 'SWDIO'));
  const standard = lintModel(model, { mode: 'standard' });
  assert.ok(!standard.findings.some(f => f.ruleId === 'R045'));
});

test('R006 downgrades optional power-output pins to P1', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U1', { Category: 'regulator' }, [
      ['1', 'IN', 'VIN'], ['2', 'GND', 'GND'], ['3', 'VOUT', ''], ['4', 'VDD', ''],
    ]),
  }));
  const lint = lintModel(model, { mode: 'quick' });
  const vout = lint.findings.find(f => f.ruleId === 'R006' && f.params.pinName === 'VOUT');
  assert.ok(vout);
  assert.equal(vout.severity, 'P1');
  const vdd = lint.findings.find(f => f.ruleId === 'R006' && f.params.pinName === 'VDD');
  assert.ok(vdd);
  assert.equal(vdd.severity, 'P0');
});

test('R018 reports no-BOM/no-PCB parts that still have connections', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Add into BOM': 'no', 'Convert to PCB': 'no' }, [['1', '', 'N1'], ['2', '', 'N2']]),
    b: comp('b', 'R2', { 'Add into BOM': 'no', 'Convert to PCB': 'no', DNP: 'yes' }, [['1', '', 'N1'], ['2', '', 'N2']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const f = lint.findings.find(x => x.ruleId === 'R018' && x.params.designator === 'R1');
  assert.ok(f);
  assert.equal(f.severity, 'P2');
  assert.ok(!lint.findings.some(x => x.ruleId === 'R018' && x.params.designator === 'R2'));
});
// ---- Batch 3: external-review fixes (BOM TSV, noise boundaries, merge flow, R046-R060) ----

test('BOM: EasyEDA TSV export parses columns, multi-designator cells, and quantities', async () => {
  const { readBom, compareBom } = await import('../scripts/bom-check.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-bom-'));
  const tsv = 'No.\tQuantity\tComment\tDesignator\tFootprint\tValue\tManufacturer Part\tManufacturer\tSupplier Part\tSupplier\tTotal Price\n' +
    '1\t2\t10K\tR1,R2\tR0805\t\t0805\t\tC9900012714\tLCSC\t0.008\n';
  fs.writeFileSync(path.join(dir, 'bom.csv'), tsv);
  const bom = readBom(path.join(dir, 'bom.csv'));
  assert.equal(bom.available, true);
  assert.equal(bom.cols.designator, 3);
  assert.equal(bom.cols.quantity, 1);
  assert.equal(bom.cols.supplierPart, 8);
  assert.deepEqual(bom.rows[0].designators, ['R1', 'R2']);
  assert.equal(bom.rows[0].quantity, 2);
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Supplier Part': 'C9900012714', Value: '10K' }, [['1', '1', 'N1'], ['2', '2', 'N2']]),
    b: comp('b', 'R2', { 'Supplier Part': 'C9900012714', Value: '10K' }, [['1', '1', 'N3'], ['2', '2', 'N4']]),
  }));
  assert.equal(compareBom(model, bom).issues.length, 0);
  // Quoted-comma CSV still works.
  fs.writeFileSync(path.join(dir, 'bom2.csv'), 'Quantity,Designator,Supplier Part\n2,"R1,R2",C9900012714\n');
  const bom2 = readBom(path.join(dir, 'bom2.csv'));
  assert.deepEqual(bom2.rows[0].designators, ['R1', 'R2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BOM: absurd quantity is a warning, not a finding', async () => {
  const { readBom, compareBom } = await import('../scripts/bom-check.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-bom-'));
  fs.writeFileSync(path.join(dir, 'bom.csv'), 'Quantity\tDesignator\tSupplier Part\n261043\tR1\tC123\n');
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Supplier Part': 'C123', Value: '10K' }, [['1', '1', 'N1'], ['2', '2', 'N2']]),
  }));
  const r = compareBom(model, readBom(path.join(dir, 'bom.csv')));
  assert.ok(!r.issues.some(i => i.kind === 'quantity-mismatch'));
  assert.ok(r.warnings.some(w => w.includes('异常')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('R020 ignores port-style names, short names, and intentional pairs', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [
      ['1', 'P000', 'P000'], ['2', 'P001', 'P001'], ['3', 'P010', 'P010'],
      ['4', 'DN', 'DN'], ['5', 'DP', 'DP'],
      ['6', 'MOSI', 'SPI_MOSI'], ['7', 'MOSII', 'SPI_MOSII'],
    ]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const r020 = lint.findings.filter(f => f.ruleId === 'R020');
  assert.ok(!r020.some(f => /P0\d\d/.test(f.params.netA) || /P0\d\d/.test(f.params.netB)));
  assert.ok(!r020.some(f => [f.params.netA, f.params.netB].includes('DN')));
  assert.ok(r020.some(f => f.params.netA === 'SPI_MOSI' || f.params.netB === 'SPI_MOSI'));
});

test('R007 accepts VBUS/VOUT pin names as power sources', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'VBUS', '+5V'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'VIN', '+5V'], ['2', 'GND', 'GND']]),
    c: comp('c', 'U3', {}, [['1', 'VOUT', '3V3'], ['2', 'GND', 'GND']]),
    d: comp('d', 'U4', {}, [['1', 'VCC', '3V3'], ['2', 'GND', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(!lint.findings.some(f => f.ruleId === 'R007'));
});

test('R007 traverses a 3-pin power-select jumper with numeric pins', () => {
  const model = buildModel(netlist({
    j: comp('j', 'J1', {}, [['1', '1', '+5V']]),
    h: comp('h', 'U10', {}, [['1', '1', '+5V'], ['2', '2', 'VCC'], ['3', '3', '3V3']]),
    u: comp('u', 'U5', {}, [['1', 'VCC', 'VCC'], ['2', 'GND', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(!lint.findings.some(f => f.ruleId === 'R007'));
});

test('R005 suppresses R001 on the same dangling net', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'SIG', 'N1']]),
  }));
  model.drc = [{ rule: 'SHOWDANDLING', primitives: [{ name: 'N1', primitiveId: 'p1' }] }];
  model.drcAvailable = true;
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R005' && f.params.net === 'N1'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R001' && f.params.net === 'N1'));
});

test('R046 reports reset pins tied to rails, including composite pin names', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'RES', 'GND'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'NRST', 'VCC']]),
    c: comp('c', 'U3', {}, [['1', 'P1/RST', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const f1 = lint.findings.find(f => f.ruleId === 'R046' && f.params.designator === 'U1');
  assert.ok(f1);
  assert.equal(f1.severity, 'P0');
  const f2 = lint.findings.find(f => f.ruleId === 'R046' && f.params.designator === 'U2');
  assert.ok(f2);
  assert.equal(f2.severity, 'P1');
  assert.ok(lint.findings.some(f => f.ruleId === 'R046' && f.params.designator === 'U3'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R010' && f.params.designator === 'U1'));
});

test('R047 reports two power outputs directly on one rail', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U8', {}, [['1', 'V3', '3V3'], ['2', 'GND', 'GND']]),
    b: comp('b', 'U11', {}, [['1', 'VOUT', '3V3'], ['2', 'VIN', '+5V']]),
    c: comp('c', 'C1', {}, [['1', '1', '3V3'], ['2', '2', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const f = lint.findings.find(x => x.ruleId === 'R047' && x.params.net === '3V3');
  assert.ok(f);
  assert.equal(f.severity, 'P1');
  assert.ok(f.params.designators.includes('U8') && f.params.designators.includes('U11'));
});

test('R048 reports floating USB-C CC pins and accepts Rd pulldowns', () => {
  const base = {
    usb: comp('usb', 'USB1', {}, [['A5', 'CC1', 'CC1'], ['B5', 'CC2', 'CC2'], ['A9', 'VBUS', '+5V']]),
    u: comp('u', 'U1', {}, [['1', 'VBUS', '+5V']]),
  };
  const lint1 = lintModel(buildModel(netlist(base)), { mode: 'standard' });
  assert.equal(lint1.findings.filter(f => f.ruleId === 'R048').length, 2);
  const withRd = {
    ...base,
    r1: comp('r1', 'R1', { Value: '5.1K' }, [['1', '1', 'CC1'], ['2', '2', 'GND']]),
    r2: comp('r2', 'R2', { Value: '5.1K' }, [['1', '1', 'CC2'], ['2', '2', 'GND']]),
  };
  const lint2 = lintModel(buildModel(netlist(withRd)), { mode: 'standard' });
  assert.equal(lint2.findings.filter(f => f.ruleId === 'R048').length, 0);
});

test('R049 reports core-regulator pins without a local cap or routed to a connector', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U5', {}, [['1', 'VCL', 'VCL'], ['2', 'VCC', '3V3']]),
    j: comp('j', 'J1', {}, [['1', '1', 'VCL']]),
    c: comp('c', 'C1', {}, [['1', '1', '3V3'], ['2', '2', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R049' && f.params.designator === 'U5'));
  const fixed = buildModel(netlist({
    u: comp('u', 'U5', {}, [['1', 'VCL', 'VCL'], ['2', 'VCC', '3V3']]),
    c1: comp('c1', 'C1', {}, [['1', '1', 'VCL'], ['2', '2', 'GND']]),
    c2: comp('c2', 'C2', {}, [['1', '1', '3V3'], ['2', '2', 'GND']]),
  }));
  assert.ok(!lintModel(fixed, { mode: 'standard' }).findings.some(f => f.ruleId === 'R049'));
});

test('R050 reports one supplier part used with different values', () => {
  const model = buildModel(netlist({
    a: comp('a', 'R1', { 'Supplier Part': 'C9900012714', Value: '10K' }, [['1', '1', 'N1'], ['2', '2', 'N2']]),
    b: comp('b', 'R2', { 'Supplier Part': 'C9900012714', Value: '4.7K' }, [['1', '1', 'N3'], ['2', '2', 'N4']]),
    c: comp('c', 'R3', { 'Supplier Part': 'C9900012714', Value: '10K' }, [['1', '1', 'N5'], ['2', '2', 'N6']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const f = lint.findings.find(x => x.ruleId === 'R050' && x.params.part === 'C9900012714');
  assert.ok(f);
  assert.equal(f.severity, 'P1');
  assert.ok(f.params.values.includes('10K') && f.params.values.includes('4.7K'));
});

test('R051 reports power-select jumpers but not ferrites between rails', () => {
  const model = buildModel(netlist({
    h: comp('h', 'U10', {}, [['1', '1', '+5V'], ['2', '2', 'VCC'], ['3', '3', '3V3']]),
    fb: comp('fb', 'FB1', { Category: 'ferrite' }, [['1', '1', '+5V'], ['2', '2', 'VCC']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R051' && f.params.designator === 'U10'));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R051' && f.params.designator === 'FB1'));
});

test('R052 reports VREFH/VREFL segments without decoupling', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U5', {}, [['1', 'P010/VREFH0', 'P010'], ['2', 'P011/VREFL0', 'P011']]),
    j: comp('j', 'J1', {}, [['1', '1', 'P010'], ['2', '2', 'P011']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.equal(lint.findings.filter(f => f.ruleId === 'R052').length, 2);
});

test('R053 counts decoupling caps per power pin in strict mode only', () => {
  const model = buildModel(netlist({
    u: comp('u', 'U1', {}, [['1', 'VCC', '3V3'], ['2', 'VCC', '3V3'], ['3', 'GND', 'GND']]),
    c: comp('c', 'C1', {}, [['1', '1', '3V3'], ['2', '2', 'GND']]),
  }));
  assert.ok(lintModel(model, { mode: 'strict' }).findings.some(f => f.ruleId === 'R053' && f.params.pins === 2 && f.params.caps === 1));
  assert.ok(!lintModel(model, { mode: 'standard' }).findings.some(f => f.ruleId === 'R053'));
});

test('R054 reports connector data lines without TVS, accepts TVS arrays', () => {
  const base = {
    j: comp('j', 'J1', {}, [['1', 'DP', 'USB_DP'], ['2', 'GND', 'GND']]),
    u: comp('u', 'U1', {}, [['1', 'DP', 'USB_DP']]),
  };
  const lint1 = lintModel(buildModel(netlist(base)), { mode: 'standard' });
  assert.ok(lint1.findings.some(f => f.ruleId === 'R054' && f.params.net === 'USB_DP'));
  const withTvs = { ...base, t: comp('t', 'TVS1', { Category: 'tvs' }, [['1', '1', 'USB_DP'], ['2', '2', 'GND']]) };
  assert.ok(!lintModel(buildModel(netlist(withTvs)), { mode: 'standard' }).findings.some(f => f.ruleId === 'R054'));
});

test('R055 flags cross-domain direct connections in strict mode only', () => {
  const model = buildModel(netlist({
    a: comp('a', 'U1', {}, [['1', 'VCC', '5V'], ['2', 'OUT', 'SIG'], ['3', 'GND', 'GND']]),
    b: comp('b', 'U2', {}, [['1', 'VCC', '3V3'], ['2', 'IN', 'SIG']]),
  }));
  assert.ok(lintModel(model, { mode: 'strict' }).findings.some(f => f.ruleId === 'R055' && f.params.net === 'SIG'));
  assert.ok(!lintModel(model, { mode: 'standard' }).findings.some(f => f.ruleId === 'R055'));
});

test('R056 estimates LED current from rail and resistor, ignoring package codes', () => {
  const model = buildModel(netlist({
    led: comp('led', 'LED1', { Category: 'led' }, [['1', 'A', '3V3'], ['2', 'K', 'N1']]),
    r: comp('r', 'R4', { Value: '4.7K' }, [['1', '1', 'N1'], ['2', '2', 'GND']]),
  }));
  const f = lintModel(model, { mode: 'standard' }).findings.find(x => x.ruleId === 'R056');
  assert.ok(f);
  assert.equal(f.params.designator, 'LED1');
  const ok = buildModel(netlist({
    led: comp('led', 'LED1', { Category: 'led' }, [['1', 'A', '3V3'], ['2', 'K', 'N1']]),
    r: comp('r', 'R4', { Value: '330R' }, [['1', '1', 'N1'], ['2', '2', 'GND']]),
  }));
  assert.ok(!lintModel(ok, { mode: 'standard' }).findings.some(x => x.ruleId === 'R056'));
});

test('R058 reports crystal nets routed to headers', () => {
  const model = buildModel(netlist({
    x: comp('x', 'X1', {}, [['1', 'OSC1', 'N1'], ['2', 'OSC2', 'N2']]),
    j: comp('j', 'J1', {}, [['1', '1', 'N1']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.findings.some(f => f.ruleId === 'R058' && f.params.designator === 'X1'));
});

test('R060 aggregates auto-named connector nets in strict mode only', () => {
  const model = buildModel(netlist({
    j: comp('j', 'J1', {}, [['1', '1', 'P000'], ['2', '2', 'P001'], ['3', '3', 'P002']]),
  }));
  const strict = lintModel(model, { mode: 'strict' }).findings.find(f => f.ruleId === 'R060');
  assert.ok(strict);
  assert.equal(strict.params.count, 3);
  assert.ok(!lintModel(model, { mode: 'standard' }).findings.some(f => f.ruleId === 'R060'));
});

test('SWD headers produce a pinout open question; SBU pins are not defects', () => {
  const model = buildModel(netlist({
    j: comp('j', 'U7', { Name: 'SIP4' }, [['1', '1', 'VCC'], ['2', '2', 'GND'], ['3', '3', 'SWDIO'], ['4', '4', 'SWCLK']]),
    usb: comp('usb', 'USB1', {}, [['A8', 'SBU1', ''], ['B8', 'SBU2', ''], ['A5', 'CC1', 'CC1'], ['B5', 'CC2', 'CC2']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  assert.ok(lint.openQuestions.some(q => q.question.includes('U7') && q.question.includes('线序')));
  assert.ok(lint.openQuestions.some(q => q.question.includes('SBU1')));
  assert.ok(!lint.findings.some(f => f.ruleId === 'R002' && /SBU/.test(f.params.pinName || '')));
});

test('R023 runs in standard mode for connector-fed rails', () => {
  const model = buildModel(netlist({
    j: comp('j', 'J1', {}, [['1', '1', '+5V']]),
    u: comp('u', 'U1', {}, [['1', 'VIN', '+5V']]),
  }));
  assert.ok(lintModel(model, { mode: 'standard' }).findings.some(f => f.ruleId === 'R023' && f.params.net === '+5V'));
});

test('R016 downgrades to P3 when the BOM already provides a value', async () => {
  const { readBom } = await import('../scripts/bom-check.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-bom-'));
  fs.writeFileSync(path.join(dir, 'bom.csv'), 'Quantity\tComment\tDesignator\tSupplier Part\n1\t10K\tR1\tC123\n');
  const model = buildModel(netlist({
    a: comp('a', 'R1', {}, [['1', '1', 'N1'], ['2', '2', 'N2']]),
  }));
  const lint = lintModel(model, { mode: 'quick', bom: readBom(path.join(dir, 'bom.csv')) });
  const f = lint.findings.find(x => x.ruleId === 'R016' && x.params.designator === 'R1');
  assert.ok(f);
  assert.equal(f.severity, 'P3');
  assert.equal(f.params.inBom, 'yes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classification: U-prefix parts with header/LDO names, composite and AVCC pins', () => {
  assert.equal(classifyComponent({ designator: 'U1', name: 'D22030200553-HDR-TH_12P-P2.54-V-F', pins: [] }).category, 'connector');
  assert.equal(classifyComponent({ designator: 'U7', name: 'SIP4', pins: [] }).category, 'connector');
  assert.equal(classifyComponent({ designator: 'U11', name: 'AMS1117-3.3', pins: [] }).category, 'regulator');
  assert.equal(classifyComponent({ designator: 'U5', name: 'R7FA2E1A72DFL#AA0', pins: [] }).category, 'ic');
  assert.equal(classifyPinName('P010/VREFH0').kind, 'reference');
  assert.equal(classifyPinName('AVCC0').isPower, true);
  assert.equal(classifyPinName('AVSS0').isGround, true);
});

test('merge: one shared net is not enough to swallow a distinct AI finding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(netlist({
    a: comp('u8', 'U8', {}, [['1', 'V3', '3V3']]),
    b: comp('u11', 'U11', {}, [['1', 'VOUT', '3V3']]),
  }));
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), {
    findings: [{
      id: 'F-001', ruleId: 'R007', messageKey: 'R007.title', params: { net: '3V3' },
      severity: 'P2', confidence: 'medium', category: 'power', source: 'rule',
      evidence: [{ kind: 'net', net: '3V3', pins: [] }],
      location: { pages: [], designators: [], uids: [], nets: ['3V3'] },
    }],
    openQuestions: [], coverage: {},
  });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.power.json'), {
    findings: [{
      id: 'AI-1', severity: 'P1', confidence: 'medium', category: 'power', title: '3V3 双输出并联',
      evidence: [
        { kind: 'component', uid: 'u8', designator: 'U8' },
        { kind: 'component', uid: 'u11', designator: 'U11' },
        { kind: 'net', net: '3V3', pins: [] },
      ],
      location: { pages: [], designators: ['U8', 'U11'], uids: ['u8', 'u11'], nets: ['3V3'] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh' });
  assert.ok(result.findings.some(f => f.source === 'ai' && f.severity === 'P1'));
  assert.ok(result.findings.some(f => f.ruleId === 'R007'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge: enhancement by findingKey escalates severity, never downgrades', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(netlist({
    a: comp('u1', 'U1', {}, [['1', 'VCC', '3V3'], ['2', 'GND', 'GND']]),
  }));
  const lint = lintModel(model, { mode: 'standard' });
  const r008 = lint.findings.find(f => f.ruleId === 'R008');
  assert.ok(r008 && r008.findingKey);
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), lint);
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.power.json'), {
    findings: [{
      id: 'AI-1', severity: 'P1', confidence: 'medium', category: 'power', title: 'deeper',
      enhancesRuleFindingId: r008.findingKey,
      evidence: [{ kind: 'pin', uid: 'u1', designator: 'U1', pin: '1', net: '3V3' }],
      location: { pages: [], designators: ['U1'], uids: ['u1'], nets: ['3V3'] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh' });
  const target = result.findings.find(f => f.ruleId === 'R008');
  assert.ok(target.aiEnhancement);
  assert.equal(target.severity, 'P1');
  assert.equal(result.findings.filter(f => f.ruleId === 'R008').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge: truncation drops noise first and never cuts AI conclusions or enhancements', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  const noise = [];
  for (let i = 0; i < 40; i++) {
    noise.push({
      id: `F-${String(i + 1).padStart(3, '0')}`, ruleId: 'R020', messageKey: 'R020.title',
      params: { netA: `NA${i}`, netB: `NB${i}` }, severity: 'P3', confidence: 'low', category: 'readability',
      evidence: [{ kind: 'net', net: `NA${i}`, pins: [] }, { kind: 'net', net: `NB${i}`, pins: [] }],
      location: { pages: [], designators: [], uids: [], nets: [`NA${i}`, `NB${i}`] },
      ...(i === 0 ? { aiEnhancement: { observation: 'AI 补充', impact: '', suggestion: '', confidence: 'medium' } } : {}),
    });
  }
  noise.push({
    id: 'F-099', ruleId: 'R029', messageKey: 'R029.title', params: { net: 'VCC' },
    severity: 'P0', confidence: 'high', category: 'power',
    evidence: [{ kind: 'net', net: 'VCC', pins: [] }],
    location: { pages: [], designators: [], uids: [], nets: ['VCC'] },
  });
  writeJson(path.join(dir, 'lint.json'), { findings: noise, openQuestions: [], coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-U1.json'), {
    findings: [{
      id: 'AI-1', severity: 'P2', confidence: 'medium', category: 'component', title: 'AI 独立结论',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: [], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', maxFindings: 5 });
  assert.ok(result.findings.some(f => f.severity === 'P0'));
  assert.ok(result.findings.some(f => f.source === 'ai'));
  assert.ok(result.findings.some(f => f.ruleId === 'R020' && f.aiEnhancement));
  assert.ok(result.coverage.omittedFindings > 0);
  assert.ok(result.coverage.omittedByRule.R020 >= 30);
  fs.rmSync(dir, { recursive: true, force: true });
});test('pageFileKeyOf carries the schematic dimension and resolves collisions', () => {
  const used = new Set();
  assert.equal(pageFileKeyOf('Schematic1', 'P1', 'uuid-a', used), 'Schematic1__P1');
  assert.equal(pageFileKeyOf('Schematic2', 'P1', 'uuid-b', used), 'Schematic2__P1');
  // Same schematic name + page name (renamed schematics): UUID suffix disambiguates.
  assert.equal(pageFileKeyOf('Schematic1', 'P1', 'uuid-c', used), 'Schematic1__P1__uuid-c');
  assert.equal(pageFileKeyOf(null, 'P1', null, new Set()), 'P1');
  const used2 = new Set(['S__P']);
  assert.equal(pageFileKeyOf('S', 'P', null, used2), 'S__P__2');
  assert.equal(pageLabelOf({ pageName: 'P1', schematicName: 'Schematic1' }), 'Schematic1 / P1');
  assert.equal(pageLabelOf({ pageName: 'P1' }), 'P1');
  assert.equal(pageLabelOf({}), null);
});

test('parse-netlist maps same-named pages in different schematics to distinct labels', () => {
  const flags = { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' };
  const model = buildModel(netlist({
    a: comp('gge1', 'R1', flags, [['1', '', 'N1'], ['2', '', 'N2']]),
    b: comp('gge2', 'R2', flags, [['1', '', 'N3'], ['2', '', 'N4']]),
  }), {
    geometry: {
      currentPage: 'P1',
      pages: {
        'Schematic1__P1': {
          pageName: 'P1', pageFileKey: 'Schematic1__P1', schematicName: 'Schematic1',
          components: { gge1: { designator: 'R1' } }, designatorIndex: {}, drcPrimitives: {},
        },
        'Schematic2__P1': {
          pageName: 'P1', pageFileKey: 'Schematic2__P1', schematicName: 'Schematic2',
          components: { gge2: { designator: 'R2' } }, designatorIndex: {}, drcPrimitives: {},
        },
      },
    },
  });
  const c1 = model.components.find(c => c.uid === 'gge1');
  const c2 = model.components.find(c => c.uid === 'gge2');
  assert.equal(c1.page, 'Schematic1 / P1');
  assert.equal(c1.pageKey, 'Schematic1__P1');
  assert.equal(c2.page, 'Schematic2 / P1');
  assert.equal(c2.pageKey, 'Schematic2__P1');
  const lint = lintModel(model, { mode: 'quick' });
  const f2 = lint.findings.find(f => f.ruleId === 'R016' && (f.location.uids || []).includes('gge2'));
  assert.deepEqual(f2.location.pages, ['Schematic2 / P1']);
});

function twoSchematicModel() {
  return {
    components: [
      { uid: 'gge1', designator: 'R1' },
      { uid: 'gge2', designator: 'R1' },
    ],
    nets: [],
    geometry: {
      currentPage: 'P1',
      currentSchematic: 'Schematic1',
      pages: {
        'Schematic1__P1': {
          pageName: 'P1', pageFileKey: 'Schematic1__P1', schematicName: 'Schematic1',
          svgPath: 'page-Schematic1__P1.svg',
          components: { gge1: { designator: 'R1', bbox: { minX: 0, minY: 0, maxX: 5, maxY: 5 } } },
          designatorIndex: { R1: ['gge1'] }, drcPrimitives: {},
        },
        'Schematic2__P1': {
          pageName: 'P1', pageFileKey: 'Schematic2__P1', schematicName: 'Schematic2',
          svgPath: 'page-Schematic2__P1.svg',
          components: { gge2: { designator: 'R1', bbox: { minX: 10, minY: 10, maxX: 20, maxY: 20 } } },
          designatorIndex: { R1: ['gge2'] }, drcPrimitives: {},
        },
      },
    },
  };
}

test('choosePage skips a same-named page that lacks the finding evidence', () => {
  const model = twoSchematicModel();
  // Legacy ambiguous location.pages ['P1'] must not stop at the first name hit.
  const finding = { location: { pages: ['P1'], designators: ['R1'], uids: ['gge2'], nets: [] } };
  const hit = choosePage(finding, model);
  assert.equal(hit.key, 'Schematic2__P1');
  assert.equal(hit.mismatch, false);
  // Unique label and schematic-dimensioned key both resolve directly.
  assert.equal(choosePage({ location: { pages: ['Schematic2 / P1'], uids: ['gge2'], designators: [], nets: [] } }, model).key, 'Schematic2__P1');
  assert.equal(choosePage({ location: { pages: ['Schematic2__P1'], uids: ['gge2'], designators: [], nets: [] } }, model).key, 'Schematic2__P1');
});

test('choosePage rejects every page when uid/designator evidence matches none', () => {
  const model = twoSchematicModel();
  const ghost = choosePage({ location: { pages: ['P1'], designators: ['R9'], uids: ['ghost'], nets: [] } }, model);
  assert.equal(ghost.page, null);
  assert.equal(ghost.mismatch, true);
  // uid present but its designator contradicts the finding: placeholder, not a wrong box.
  const contradict = choosePage({ location: { pages: ['P1'], designators: ['R2'], uids: ['gge1'], nets: [] } }, model);
  assert.equal(contradict.page, null);
  assert.equal(contradict.mismatch, true);
  // No geometry at all is distinct from a mismatch.
  const empty = choosePage({ location: { pages: [], designators: [], uids: ['x'], nets: [] } }, { components: [], nets: [] });
  assert.equal(empty.mismatch, false);
  assert.equal(empty.page, null);
});

test('captureScreenshots placeholders on mismatch and crops the page that holds the evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = twoSchematicModel();
  writeJson(path.join(dir, 'model.json'), model);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
  fs.writeFileSync(path.join(dir, 'page-Schematic1__P1.svg'), svg, 'utf8');
  fs.writeFileSync(path.join(dir, 'page-Schematic2__P1.svg'), svg, 'utf8');
  writeJson(path.join(dir, 'findings.final.json'), {
    findings: [
      { id: 'F-001', severity: 'P1', evidence: [], location: { pages: ['P1'], designators: ['R1'], uids: ['gge2'], nets: [] } },
      { id: 'F-002', severity: 'P1', evidence: [], location: { pages: ['P1'], designators: ['R9'], uids: ['ghost'], nets: [] } },
    ],
  });
  const stats = captureScreenshots({ outDir: dir });
  assert.equal(stats.generated, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.items[0].reason, 'page/component mismatch');
  const after = readJson(path.join(dir, 'findings.final.json'));
  const ok = after.findings.find(f => f.id === 'F-001');
  const bad = after.findings.find(f => f.id === 'F-002');
  assert.equal(ok.screenshotPlaceholder, null);
  assert.equal(ok.screenshots[0].page, 'Schematic2 / P1');
  const shot = fs.readFileSync(path.join(dir, ok.screenshots[0].file), 'utf8');
  assert.ok(shot.includes('data-uid="gge2"'));
  assert.ok(shot.includes('viewBox="-30 -60 90 90"'));
  assert.equal(bad.screenshotPlaceholder, '截图不可用（页/器件不匹配）');
  assert.ok(!fs.existsSync(path.join(dir, 'screenshots', 'F-002.svg')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge scope page:P1 still matches schematic/page labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  const c = model.components.find(x => x.uid === 'gge1');
  c.page = 'Schematic1 / P1';
  c.pageKey = 'Schematic1__P1';
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), { findings: [], openQuestions: [], coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.component-U1.json'), {
    findings: [{
      id: 'AI-1', severity: 'P2', confidence: 'medium', category: 'component', title: 't',
      evidence: [{ kind: 'component', uid: 'gge1', designator: 'U1' }],
      location: { pages: [], designators: ['U1'], uids: ['gge1'], nets: [] },
    }],
    open_questions: [],
  });
  const aiDir = path.join(dir, 'ai');
  assert.equal(mergeFindings({ outDir: dir, aiDir, lang: 'zh', mode: 'standard', scope: 'page:P1' }).findings.length, 1);
  assert.equal(mergeFindings({ outDir: dir, aiDir, lang: 'zh', mode: 'standard', scope: 'page:Schematic1__P1' }).findings.length, 1);
  assert.equal(mergeFindings({ outDir: dir, aiDir, lang: 'zh', mode: 'standard', scope: 'page:Other' }).findings.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});test('captureScreenshots refuses a legacy overwritten page SVG (viewBox mismatch)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const model = twoSchematicModel();
  // Legacy collision: both pages share one cache file holding Schematic2's SVG.
  model.geometry.pages['Schematic1__P1'].svgPath = 'page-P1.svg';
  model.geometry.pages['Schematic2__P1'].svgPath = 'page-P1.svg';
  model.geometry.pages['Schematic1__P1'].svgViewBox = '-5 -795 1130 805';
  model.geometry.pages['Schematic2__P1'].svgViewBox = '-5 -1165 2150 1170';
  writeJson(path.join(dir, 'model.json'), model);
  fs.writeFileSync(path.join(dir, 'page-P1.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5 -1165 2150 1170"></svg>', 'utf8');
  writeJson(path.join(dir, 'findings.final.json'), {
    findings: [
      { id: 'F-001', severity: 'P1', evidence: [], location: { pages: ['Schematic1 / P1'], designators: ['R1'], uids: ['gge1'], nets: [] } },
      { id: 'F-002', severity: 'P1', evidence: [], location: { pages: ['Schematic2 / P1'], designators: ['R1'], uids: ['gge2'], nets: [] } },
    ],
  });
  const stats = captureScreenshots({ outDir: dir });
  assert.equal(stats.generated, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.items[0].reason, 'page svg viewBox mismatch');
  const after = readJson(path.join(dir, 'findings.final.json'));
  assert.equal(after.findings[0].screenshotPlaceholder, '截图不可用（页面 SVG 与几何不匹配）');
  assert.equal(after.findings[1].screenshots[0].page, 'Schematic2 / P1');
  fs.rmSync(dir, { recursive: true, force: true });
});test('pageFileKeyOf keeps Chinese schematic/page names distinct', () => {
  const used = new Set();
  assert.equal(pageFileKeyOf('瑞萨核心', 'P1', 'u1', used), '瑞萨核心__P1');
  assert.equal(pageFileKeyOf('数据采集底板', 'P1', 'u2', used), '数据采集底板__P1');
  // Identical names still collide -> UUID suffix keeps keys (and SVGs) apart.
  assert.equal(pageFileKeyOf('瑞萨核心', 'P1', 'u3', used), '瑞萨核心__P1__u3');
});

function collidingUidModel() {
  // EasyEDA primitive uids are page-local: gge1/gge2 exist on BOTH pages as
  // different physical parts. The netlist only covers Schematic1.
  return {
    components: [
      { uid: 'gge1', designator: 'U5' },
      { uid: 'gge2', designator: 'R6' },
    ],
    nets: [{ name: '3V3', isPower: true, isGround: false, pins: [{ uid: 'gge1' }, { uid: 'gge2' }] }],
    geometry: {
      currentPage: 'P1',
      currentSchematic: 'Schematic1',
      pages: {
        Schematic1__P1: {
          pageName: 'P1', pageFileKey: 'Schematic1__P1', schematicName: 'Schematic1',
          svgPath: 'page-Schematic1__P1.svg',
          components: {
            gge1: { designator: 'U5', bbox: { minX: 0, minY: 0, maxX: 5, maxY: 5 } },
            gge2: { designator: 'R6', bbox: { minX: 6, minY: 0, maxX: 9, maxY: 3 } },
          },
          designatorIndex: { U5: ['gge1'], R6: ['gge2'] }, drcPrimitives: {},
        },
        Schematic2__P1: {
          pageName: 'P1', pageFileKey: 'Schematic2__P1', schematicName: 'Schematic2',
          svgPath: 'page-Schematic2__P1.svg',
          components: {
            gge1: { designator: 'C11', bbox: { minX: 100, minY: 100, maxX: 110, maxY: 110 } },
            gge2: { designator: 'H5', bbox: { minX: 120, minY: 100, maxX: 130, maxY: 110 } },
            gge9: { designator: 'U5', bbox: { minX: 140, minY: 100, maxX: 150, maxY: 110 } },
          },
          designatorIndex: { C11: ['gge1'], H5: ['gge2'], U5: ['gge9'] }, drcPrimitives: {},
        },
      },
    },
  };
}

test('parse-netlist resolves page-local uid collisions by designator', () => {
  const flags = { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' };
  const geo = collidingUidModel().geometry;
  const model = buildModel(netlist({
    a: comp('gge1', 'U5', flags, [['1', 'RES', 'GND'], ['2', 'VCC', '3V3']]),
    b: comp('gge2', 'R6', flags, [['1', '', '3V3'], ['2', '', 'N2']]),
  }), { geometry: geo });
  const c1 = model.components.find(c => c.uid === 'gge1');
  const c2 = model.components.find(c => c.uid === 'gge2');
  assert.equal(c1.page, 'Schematic1 / P1');
  assert.equal(c1.pageKey, 'Schematic1__P1');
  assert.equal(c2.page, 'Schematic1 / P1');
});

test('choosePage rejects foreign same-uid parts and tolerates net neighbors', () => {
  const model = collidingUidModel();
  // Explicit uid gge1 is U5 in the netlist but C11 on Schematic2's page:
  // the ambiguous name hit must lose to the page where identity agrees.
  const hit = choosePage({ location: { pages: ['P1'], designators: ['U5'], uids: ['gge1'], nets: [] } }, model);
  assert.equal(hit.key, 'Schematic1__P1');
  // Net-derived neighbor gge2 (R6) is not in designators ['U5'] — that must
  // not reject the correct page, and the foreign page must still fail.
  const withNet = choosePage({ location: { pages: ['P1'], designators: ['U5'], uids: ['gge1'], nets: ['3V3'] } }, model);
  assert.equal(withNet.key, 'Schematic1__P1');
  // Designator-only finding: Schematic2 also has a "U5" (gge9) but the
  // netlist does not know that uid — only the netlist-confirmed page wins.
  const byDesignator = choosePage({ location: { pages: [], designators: ['U5'], uids: [], nets: [] } }, model);
  assert.equal(byDesignator.key, 'Schematic1__P1');
});test('cli transport parses versions and rejects unsupported clients', async () => {
  assert.deepEqual(parseCliVersion('JLCEDA Pro 4.1.103.abcdef01\nUsage: ...'), [4, 1, 103]);
  assert.deepEqual(parseCliVersion('EasyEDA Pro 4.2.0'), [4, 2, 0]);
  assert.equal(parseCliVersion('no version here'), null);
  assert.equal(versionAtLeast([4, 1, 70], CLI_MIN_VERSION), true);
  assert.equal(versionAtLeast([4, 1, 69], CLI_MIN_VERSION), false);
  assert.equal(versionAtLeast([4, 2, 0], CLI_MIN_VERSION), true);
  assert.equal(versionAtLeast([5, 0, 0], CLI_MIN_VERSION), true);
  assert.equal(versionAtLeast(null, CLI_MIN_VERSION), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const exe = path.join(dir, 'fake-cli.exe');
  fs.writeFileSync(exe, '', 'utf8');
  const spawnFn = (candidate, args) => {
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103.abcdef01\n' };
    return { status: 0, stdout: JSON.stringify({ ok: true, value: null }) };
  };
  const found = detectCli({ explicit: exe, spawnFn });
  assert.equal(found.executable, exe);
  assert.deepEqual(found.version, [4, 1, 103]);
  // Too old: openCliTransport refuses before opening a session.
  let opened = false;
  const oldSpawn = (candidate, args) => {
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.50\n' };
    opened = true;
    return { status: 0, stdout: JSON.stringify({ ok: true, value: {} }) };
  };
  await assert.rejects(openCliTransport({ projectPath: 'x.eprj3', executable: exe, spawnFn: oldSpawn }), /版本过低/);
  assert.equal(opened, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli transport opens a session, opens the first page, invokes with eda identity, and closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const exe = path.join(dir, 'fake-cli.exe');
  fs.writeFileSync(exe, '', 'utf8');
  const calls = [];
  const openedPages = [];
  const spawnFn = (candidate, args) => {
    calls.push(args);
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103\n' };
    if (args[0] === 'open') {
      return { status: 0, stdout: JSON.stringify({ ok: true, value: { sessionId: 'sess-1', path: args[2], headless: true } }) };
    }
    if (args[0] === 'invoke') {
      const code = args[args.indexOf('--code') + 1];
      if (code.includes('getAllSchematicPagesInfo')) {
        return { status: 0, stdout: JSON.stringify({ ok: true, value: {
          pages: [{ uuid: 'pg1', name: 'P1', parentSchematicUuid: 's1' }],
          schematics: [{ uuid: 's1', name: 'Schematic1' }],
          current: null,
        } }) };
      }
      if (code.includes('openDocument')) {
        const m = code.match(/const target = "([^"]+)"/);
        if (m) openedPages.push(m[1]);
        return { status: 0, stdout: JSON.stringify({ ok: true, value: { ok: true, tabId: 'tab1', doc: { uuid: m ? m[1] : null }, activated: true } }) };
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, value: { ran: code } }) };
    }
    if (args[0] === 'session') return { status: 0, stdout: JSON.stringify({ ok: true, value: { closed: true } }) };
    return { status: 0, stdout: JSON.stringify({ ok: true, value: null }) };
  };
  const t = await openCliTransport({ projectPath: 'C:/proj/MyBoard.eprj3', executable: exe, spawnFn });
  assert.equal(t.transport, 'cli');
  assert.equal(t.sessionId, 'sess-1');
  // `open` leaves no document open in CLI sessions: the first page is opened.
  assert.deepEqual(openedPages, ['pg1']);
  assert.equal(t.pageInfo.opened.uuid, 'pg1');
  assert.equal(t.pageInfo.opened.schematicName, 'Schematic1');
  assert.equal(t.pageInfo.selectedBy, 'first');
  const openArgs = calls.find(a => a[0] === 'open');
  assert.ok(openArgs.includes('--path') && openArgs.includes('--headless'));
  const value = await t.execute('return 1 + 1', { timeoutMs: 5000 });
  assert.equal(value.ran, 'return 1 + 1');
  const invokeArgs = calls.find(a => a[0] === 'invoke' && a.includes('return 1 + 1'));
  assert.deepEqual(invokeArgs.slice(0, 6), ['invoke', '--session', 'sess-1', '--ext-uuid', 'eda', '--code']);
  assert.equal(invokeArgs[invokeArgs.indexOf('--timeout') + 1], '5000');
  t.close();
  const closeArgs = calls.find(a => a[0] === 'session');
  assert.deepEqual(closeArgs, ['session', 'close', '--session', 'sess-1', '--destroy']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli transport surfaces ok:false envelopes as errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const exe = path.join(dir, 'fake-cli.exe');
  fs.writeFileSync(exe, '', 'utf8');
  const spawnFn = (candidate, args) => {
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103\n' };
    if (args[0] === 'invoke') {
      return { status: 0, stdout: JSON.stringify({ ok: false, error: { code: 'EXECUTION_ERROR', message: 'boom' } }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, value: { sessionId: 's2' } }) };
  };
  assert.throws(() => cliInvoke(exe, 's2', 'return 1', { spawnFn }), /boom/);
  // Non-JSON output (e.g. GUI noise) is an error, never silently ignored.
  const badSpawn = () => ({ status: 0, stdout: 'not json' });
  assert.throws(() => runCliJson(exe, ['invoke'], { spawnFn: badSpawn }), /不是 JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectLive runs the full collection over an injected executor (no Bridge)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const enet = JSON.stringify(netlist({
    a: comp('gge1', 'R1', { 'Add into BOM': 'yes', 'Convert to PCB': 'yes' }, [['1', '', 'N1'], ['2', '', 'N2']]),
  }));
  const exec = async (code) => {
    if (code.includes('getNetlistFile')) {
      return {
        ok: true,
        doc: { uuid: 'p1', name: 'P1' },
        project: { name: 'Proj' },
        version: '4.1.103',
        pagesInfo: [{ uuid: 'p1', name: 'P1', pageUuid: 'p1' }],
        schematicsInfo: [],
        netlist: enet,
        bom: 'Designator\tValue\nR1\t1k\n',
        drc: [],
        pins: [],
        components: [{ uid: 'gge1', designator: 'R1', primitiveId: 'e1', bbox: { minX: 0, minY: 0, maxX: 10, maxY: 5 } }],
        svg: '<svg viewBox="0 0 100 100"></svg>',
      };
    }
    return { ok: true };
  };
  const summary = await collectLive({
    outDir: dir,
    executeCode: exec,
    transportInfo: { transport: 'test', projectPath: 'C:/proj/MyBoard.eprj3' },
  });
  assert.equal(summary.transport, 'test');
  assert.equal(summary.projectPath, 'C:/proj/MyBoard.eprj3');
  assert.equal(summary.pageName, 'P1');
  assert.ok(fs.existsSync(path.join(dir, 'design.enet')));
  assert.ok(fs.existsSync(path.join(dir, 'bom.csv')));
  const geo = readJson(path.join(dir, 'geometry.json'));
  assert.ok(geo.pages.__current__);
  assert.equal(geo.pages.P1.components.gge1.designator, 'R1');
  assert.deepEqual(geo.pages.__current__.components.gge1.bbox, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  const collect = readJson(path.join(dir, 'collect.json'));
  assert.equal(collect.transport, 'test');
  fs.rmSync(dir, { recursive: true, force: true });
});function cliPageFake({ pages, schematics = [], current = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const exe = path.join(dir, 'fake-cli.exe');
  fs.writeFileSync(exe, '', 'utf8');
  const calls = [];
  const openedPages = [];
  const spawnFn = (candidate, args) => {
    calls.push(args);
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103\n' };
    if (args[0] === 'open') return { status: 0, stdout: JSON.stringify({ ok: true, value: { sessionId: 's9', path: args[2], headless: true } }) };
    if (args[0] === 'invoke') {
      const code = args[args.indexOf('--code') + 1];
      if (code.includes('getAllSchematicPagesInfo')) {
        return { status: 0, stdout: JSON.stringify({ ok: true, value: { pages, schematics, current } }) };
      }
      if (code.includes('openDocument')) {
        const m = code.match(/const target = "([^"]+)"/);
        if (m) openedPages.push(m[1]);
        return { status: 0, stdout: JSON.stringify({ ok: true, value: { ok: true, tabId: 'tab', doc: { uuid: m ? m[1] : null }, activated: true } }) };
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, value: {} }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, value: { closed: true } }) };
  };
  return { exe, dir, spawnFn, calls, openedPages };
}

test('cli mode reuses an already-open document', async () => {
  const fake = cliPageFake({
    pages: [{ uuid: 'pg1', name: 'P1', parentSchematicUuid: 's1' }],
    schematics: [{ uuid: 's1', name: 'Schematic1' }],
    current: { uuid: 'pg1' },
  });
  const t = await openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: fake.exe, spawnFn: fake.spawnFn });
  assert.equal(t.pageInfo.selectedBy, 'already-open');
  assert.deepEqual(fake.openedPages, []);
  fs.rmSync(fake.dir, { recursive: true, force: true });
});

test('cli mode --page selects a page by uuid or unique name, rejects ambiguity', async () => {
  const pages = [
    { uuid: 'u1', name: 'P1', parentSchematicUuid: 's1' },
    { uuid: 'u2', name: 'P1', parentSchematicUuid: 's2' },
    { uuid: 'u3', name: 'P2', parentSchematicUuid: 's2' },
  ];
  const schematics = [{ uuid: 's1', name: 'Core' }, { uuid: 's2', name: 'Base' }];

  const byName = cliPageFake({ pages, schematics });
  const t = await openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: byName.exe, pageId: 'P2', spawnFn: byName.spawnFn });
  assert.deepEqual(byName.openedPages, ['u3']);
  assert.equal(t.pageInfo.opened.schematicName, 'Base');
  assert.equal(t.pageInfo.selectedBy, 'explicit');

  const byUuid = cliPageFake({ pages, schematics });
  await openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: byUuid.exe, pageId: 'u1', spawnFn: byUuid.spawnFn });
  assert.deepEqual(byUuid.openedPages, ['u1']);

  const ambiguous = cliPageFake({ pages, schematics });
  await assert.rejects(
    openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: ambiguous.exe, pageId: 'P1', spawnFn: ambiguous.spawnFn }),
    /不唯一/,
  );
  assert.deepEqual(ambiguous.openedPages, []);

  const missing = cliPageFake({ pages, schematics });
  await assert.rejects(
    openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: missing.exe, pageId: 'nope', spawnFn: missing.spawnFn }),
    /图页不存在/,
  );
  fs.rmSync(byName.dir, { recursive: true, force: true });
  fs.rmSync(byUuid.dir, { recursive: true, force: true });
  fs.rmSync(ambiguous.dir, { recursive: true, force: true });
  fs.rmSync(missing.dir, { recursive: true, force: true });
});

test('cli mode fails clearly when the project has no schematic page', async () => {
  const fake = cliPageFake({ pages: [], schematics: [] });
  await assert.rejects(
    openCliTransport({ projectPath: 'C:/proj/Empty.eprj3', executable: fake.exe, spawnFn: fake.spawnFn, readyPollMs: 2, readyTimeoutMs: 10 }),
    /没有可打开的原理图图页/,
  );
  fs.rmSync(fake.dir, { recursive: true, force: true });
});test('merge: a distinct AI finding sharing only components is not swallowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(netlist({
    a: comp('u1', 'U1', {}, [['7', 'GND', 'GND'], ['8', 'VCC', '3V3']]),
    b: comp('u3', 'U3', {}, [['2', 'VBAT_S', 'VBAT_S'], ['3', 'VBAT', 'VBAT']]),
  }));
  writeJson(path.join(dir, 'model.json'), model);
  // Rule says GND short; AI says the VBAT rail is broken. Both cite U1/U3,
  // but they are different defects — the AI P0 must survive as its own entry.
  writeJson(path.join(dir, 'lint.json'), {
    findings: [{
      id: 'F-001', ruleId: 'R029', messageKey: 'R029.title', params: { net: 'GND' },
      severity: 'P0', confidence: 'high', category: 'power', source: 'rule',
      evidence: [{ kind: 'pin', uid: 'u1', designator: 'U1', pin: '7', net: 'GND' }],
      location: { pages: [], designators: ['U1', 'U3'], uids: ['u1', 'u3'], nets: ['GND'] },
    }],
    openQuestions: [], coverage: {},
  });
  ensureDir(path.join(dir, 'ai'));
  writeJson(path.join(dir, 'ai', 'findings.ai.power.json'), {
    findings: [{
      id: 'AI-1', severity: 'P0', confidence: 'high', category: 'power', title: 'VBAT_S 与 VBAT 断链',
      evidence: [
        { kind: 'pin', uid: 'u3', designator: 'U3', pin: '2', net: 'VBAT_S' },
        { kind: 'pin', uid: 'u3', designator: 'U3', pin: '3', net: 'VBAT' },
      ],
      location: { pages: [], designators: ['U1', 'U3'], uids: ['u1', 'u3'], nets: ['VBAT_S', 'VBAT'] },
    }],
  });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh' });
  assert.ok(result.findings.some(f => f.ruleId === 'R029'));
  const ai = result.findings.find(f => f.source === 'ai');
  assert.ok(ai, 'AI P0 must remain an independent finding');
  assert.equal(ai.severity, 'P0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge: AI enhancements accumulate instead of overwriting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(netlist({
    a: comp('u1', 'U1', {}, [['1', 'VCC', '3V3'], ['2', 'GND', 'GND']]),
  }));
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'lint.json'), {
    findings: [{
      id: 'F-001', ruleId: 'R008', findingKey: 'R008:testkey', messageKey: 'R008.title', params: {},
      severity: 'P2', confidence: 'medium', category: 'power', source: 'rule',
      evidence: [{ kind: 'pin', uid: 'u1', designator: 'U1', pin: '1', net: '3V3' }],
      location: { pages: [], designators: ['U1'], uids: ['u1'], nets: ['3V3'] },
    }],
    openQuestions: [], coverage: {},
  });
  ensureDir(path.join(dir, 'ai'));
  const enh = (id, title) => ({
    id, severity: 'P2', confidence: 'medium', category: 'power', title,
    enhancesRuleFindingId: 'R008:testkey',
    evidence: [{ kind: 'pin', uid: 'u1', designator: 'U1', pin: '1', net: '3V3' }],
    location: { pages: [], designators: ['U1'], uids: ['u1'], nets: ['3V3'] },
  });
  writeJson(path.join(dir, 'ai', 'findings.ai.power.json'), { findings: [enh('AI-1', 'first'), enh('AI-2', 'second')] });
  const result = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh' });
  const target = result.findings.find(f => f.ruleId === 'R008');
  assert.equal(target.aiEnhancements.length, 2);
  assert.equal(target.aiEnhancements[0].observation, 'first');
  assert.equal(target.aiEnhancement.observation, 'first');
  assert.equal(result.findings.filter(f => f.ruleId === 'R008').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('merge: maxFindings Infinity and maxQuestions Infinity keep everything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-merge-'));
  const model = buildModel(loadNe555(), { source: { mode: 'file' } });
  writeJson(path.join(dir, 'model.json'), model);
  const findings = [];
  for (let i = 0; i < 40; i++) {
    findings.push({
      id: `F-${String(i + 1).padStart(3, '0')}`, ruleId: 'R020', messageKey: 'R020.title',
      params: { netA: `NA${i}`, netB: `NB${i}` }, severity: 'P3', confidence: 'low', category: 'readability',
      evidence: [{ kind: 'net', net: `NA${i}`, pins: [] }],
      location: { pages: [], designators: [], uids: [], nets: [`NA${i}`, `NB${i}`] },
    });
  }
  const questions = [];
  for (let i = 0; i < 20; i++) questions.push({ question: `Q${i}?`, related: [], why: '' });
  writeJson(path.join(dir, 'lint.json'), { findings, openQuestions: questions, coverage: {} });
  ensureDir(path.join(dir, 'ai'));
  const full = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', maxFindings: Infinity, maxQuestions: Infinity });
  assert.equal(full.findings.length, 40);
  assert.equal(full.coverage.omittedFindings, 0);
  assert.equal(full.openQuestions.length, 20);
  assert.equal(full.coverage.omittedQuestions, 0);
  const capped = mergeFindings({ outDir: dir, aiDir: path.join(dir, 'ai'), lang: 'zh', maxFindings: 5 });
  assert.equal(capped.openQuestions.length, 15);
  assert.equal(capped.coverage.omittedQuestions, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cli mode waits for project loading before opening a page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-review-test-'));
  const exe = path.join(dir, 'fake-cli.exe');
  fs.writeFileSync(exe, '', 'utf8');
  let listCalls = 0;
  const spawnFn = (candidate, args) => {
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103\n' };
    if (args[0] === 'open') return { status: 0, stdout: JSON.stringify({ ok: true, value: { sessionId: 's7' } }) };
    if (args[0] === 'invoke') {
      const code = args[args.indexOf('--code') + 1];
      if (code.includes('getAllSchematicPagesInfo')) {
        listCalls++;
        const pages = listCalls >= 3 ? [{ uuid: 'pg1', name: 'P1', parentSchematicUuid: 's1' }] : [];
        return { status: 0, stdout: JSON.stringify({ ok: true, value: { pages, schematics: [{ uuid: 's1', name: 'Schematic1' }], current: null } }) };
      }
      if (code.includes('openDocument')) {
        return { status: 0, stdout: JSON.stringify({ ok: true, value: { ok: true, tabId: 'tab1', doc: { uuid: 'pg1' }, activated: true } }) };
      }
      return { status: 0, stdout: JSON.stringify({ ok: true, value: {} }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, value: { closed: true } }) };
  };
  const t = await openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: exe, spawnFn, readyPollMs: 1, readyTimeoutMs: 500 });
  assert.equal(listCalls, 3);
  assert.equal(t.pageInfo.opened.uuid, 'pg1');

  // Never ready -> explicit timeout error mentioning the project did not load.
  let emptyLists = 0;
  const neverReady = (candidate, args) => {
    if (args[0] === '--help') return { status: 0, stdout: 'JLCEDA Pro 4.1.103\n' };
    if (args[0] === 'open') return { status: 0, stdout: JSON.stringify({ ok: true, value: { sessionId: 's8' } }) };
    if (args[0] === 'invoke') {
      emptyLists++;
      return { status: 0, stdout: JSON.stringify({ ok: true, value: { pages: [], schematics: [], current: null } }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true, value: { closed: true } }) };
  };
  await assert.rejects(
    openCliTransport({ projectPath: 'C:/proj/Board.eprj3', executable: exe, spawnFn: neverReady, readyPollMs: 2, readyTimeoutMs: 10 }),
    /未加载完成|没有可打开/,
  );
  assert.ok(emptyLists >= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});