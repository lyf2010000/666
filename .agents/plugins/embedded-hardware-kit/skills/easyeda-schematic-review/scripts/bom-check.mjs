import fs from 'node:fs';
import { csvParse, decodeText, detectDelimiter } from './lib/util.mjs';

const HEADER_MAP = {
  designator: ['位号', '器件位号', 'designator', 'designators', 'refdes', 'reference'],
  quantity: ['数量', 'qty', 'quantity'],
  value: ['值', '参数', 'value', 'comment'],
  supplierPart: ['供应商料号', '立创编号', 'supplier part', 'supplierpart', 'lcsc part', 'lcsc'],
};

function normalizeHeader(h) {
  return String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findColumn(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(headers[i]);
    if (aliases.some(a => h === a.toLowerCase() || h.includes(a.toLowerCase()))) return i;
  }
  return -1;
}

export function readBom(file) {
  if (!file) return { available: false, reason: 'not-provided', rows: [], warnings: [] };
  if (!fs.existsSync(file)) return { available: false, reason: 'missing-file', rows: [], warnings: [`BOM 文件不存在: ${file}`] };
  const buf = fs.readFileSync(file);
  const text = decodeText(buf);
  const rawRows = csvParse(text, detectDelimiter(text));
  if (rawRows.length < 2) return { available: false, reason: 'empty', rows: [], warnings: ['BOM 无数据行'] };
  const headers = rawRows[0];
  const cols = {
    designator: findColumn(headers, HEADER_MAP.designator),
    quantity: findColumn(headers, HEADER_MAP.quantity),
    value: findColumn(headers, HEADER_MAP.value),
    supplierPart: findColumn(headers, HEADER_MAP.supplierPart),
  };
  const warnings = [];
  if (cols.designator < 0) {
    return { available: false, reason: 'no-designator-column', headers, rows: [], warnings: ['BOM 缺少位号列'] };
  }
  if (cols.quantity < 0) warnings.push('BOM 缺少数量列，数量一致性检查跳过');
  const rows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const designatorText = String(r[cols.designator] ?? '').trim();
    if (!designatorText) continue;
    const designators = designatorText.split(/[,;，；\s]+/).map(s => s.trim()).filter(Boolean);
    const qty = cols.quantity >= 0 ? Number(String(r[cols.quantity] ?? '').replace(/[^\d.-]/g, '')) : null;
    rows.push({
      line: i + 1,
      designators,
      quantity: Number.isFinite(qty) ? qty : null,
      value: cols.value >= 0 ? String(r[cols.value] ?? '').trim() : '',
      supplierPart: cols.supplierPart >= 0 ? String(r[cols.supplierPart] ?? '').trim() : '',
    });
  }
  const byDesignator = new Map();
  for (const row of rows) {
    for (const d of row.designators) {
      if (!byDesignator.has(d)) byDesignator.set(d, []);
      byDesignator.get(d).push(row);
    }
  }
  return { available: true, reason: null, headers, cols, rows, byDesignator, warnings };
}

/**
 * Deterministic BOM/netlist consistency comparison.
 * Returns issue records without severities; lint maps them to findings.
 */
export function compareBom(model, bom) {
  if (!bom?.available) return { available: false, reason: bom?.reason || 'unavailable', issues: [], warnings: bom?.warnings || [] };
  const issues = [];
  const warnings = [...(bom.warnings || [])];
  const expected = new Map(model.components.filter(c => c.addIntoBom).map(c => [c.designator, c]));
  for (const row of bom.rows) {
    if (row.quantity != null && row.designators.length && row.quantity !== row.designators.length) {
      // 数量异常大通常是列错位/解析异常，降级为 warning，避免整板噪声。
      if (row.quantity > 10000) {
        warnings.push(`BOM 第 ${row.line} 行数量 ${row.quantity} 异常，疑似列错位，数量检查跳过`);
        continue;
      }
      issues.push({
        kind: 'quantity-mismatch',
        designators: row.designators,
        line: row.line,
        detail: `BOM 第 ${row.line} 行数量 ${row.quantity} 与位号数 ${row.designators.length} 不一致`,
      });
    }
  }
  for (const [designator, comp] of expected) {
    if (!bom.byDesignator.has(designator)) {
      issues.push({ kind: 'missing-in-bom', designators: [designator], comp, detail: `网表器件 ${designator} 不在 BOM 中` });
      continue;
    }
    if (comp.supplierPart) {
      const normPart = s => String(s).replace(/\s+/g, '').toUpperCase();
      for (const row of bom.byDesignator.get(designator)) {
        if (row.supplierPart && normPart(row.supplierPart) !== normPart(comp.supplierPart)) {
          issues.push({
            kind: 'supplier-mismatch', designators: [designator], comp,
            detail: `BOM 料号 ${row.supplierPart} 与网表 ${comp.supplierPart} 不一致`,
          });
        }
      }
    }
  }
  const seen = new Set();
  for (const row of bom.rows) {
    for (const d of row.designators) {
      if (!expected.has(d) && !seen.has(d)) {
        seen.add(d);
        issues.push({ kind: 'extra-in-bom', designators: [d], detail: `BOM 位号 ${d} 不在网表 addIntoBom 集合中` });
      }
    }
  }
  return { available: true, issues, warnings };
}
