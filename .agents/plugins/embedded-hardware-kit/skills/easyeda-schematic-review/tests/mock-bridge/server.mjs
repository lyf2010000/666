import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'projects', 'ne555.enet');
const netlist = fs.readFileSync(fixture, 'utf8');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1191" height="846" viewBox="-10.5 -835.5 1191 846"><rect x="549" y="-431" width="92" height="52" fill="#dbeafe"/><text x="550" y="-430">U1</text></svg>`;
const port = Number(process.env.MOCK_BRIDGE_PORT || 49629);

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { service: 'easyeda-bridge', status: 'ok', edaConnected: true, edaWindowCount: 1 });
  }
  if (req.method === 'GET' && req.url === '/eda-windows') {
    return json(res, 200, { windows: [{ windowId: 'mock-window', connected: true, active: true }], activeWindowId: 'mock-window', count: 1 });
  }
  if (req.method === 'POST' && req.url === '/eda-windows/select') {
    return json(res, 200, { success: true, activeWindowId: 'mock-window' });
  }
  if (req.method === 'POST' && req.url === '/execute') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let code = '';
    try { code = JSON.parse(body).code || ''; } catch { return json(res, 400, { success: false, error: 'bad json' }); }
    if (code.includes('getNetlistFile')) {
      return json(res, 200, {
        success: true,
        result: {
          ok: true,
          doc: { uuid: 'page-1', name: 'P1', type: 'schematic' },
          project: { name: 'Mock Project', boardName: 'Board1', schematicName: 'Schematic1' },
          version: '4.1.99',
          netlist,
          bom: '位号,数量,值,供应商料号\nU1,1,NE555,C504549\nR1,1,10K,C9900011271\nC1,1,100nF,C2167746\nR2,1,100k,C9900012835\nC2,1,100nF,C2167746\n',
          drc: [{ type: 'warn', rule: 'SHOWDANDLING', primitives: [{ primitiveId: 'drc-1', sheet: 'page-1', name: '$1N14' }] }],
          pins: [{ uid: 'gge1', designator: 'U1', pins: [{ number: '1', name: 'GND', pinType: 'Undefined', noConnect: false }] }],
          components: [
            { uid: 'gge1', designator: 'U1', primitiveId: 'prim-u1', bbox: { minX: 549.5, minY: 379.5, maxX: 640.5, maxY: 430.5 } },
            { uid: 'gge2', designator: 'R1', primitiveId: 'prim-r1', bbox: { minX: 300, minY: 300, maxX: 340, maxY: 340 } },
          ],
          svg,
        },
      });
    }
    if (code.includes('getAllPins')) {
      return json(res, 200, { success: true, result: [{ uid: 'gge1', designator: 'U1', pins: [] }] });
    }
    if (code.includes('getSchematicPagesInfo')) {
      return json(res, 200, { success: true, result: { pages: [{ uuid: 'page-1', name: 'P1' }], current: { uuid: 'page-1' } } });
    }
    if (code.includes('getExportDocumentFile')) {
      return json(res, 200, { success: true, result: null });
    }
    if (code.includes('getPrimitivesBBox')) {
      return json(res, 200, { success: true, result: { minX: 549.5, minY: 379.5, maxX: 640.5, maxY: 430.5 } });
    }
    return json(res, 200, { success: true, result: { ok: true } });
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock bridge on http://127.0.0.1:${port}`);
});
