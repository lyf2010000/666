import fs from 'node:fs';
import path from 'node:path';
import { REF_DIR } from './util.mjs';

const cache = new Map();

export function loadMessages(lang = 'zh') {
  const l = lang === 'en' ? 'en' : 'zh';
  if (cache.has(l)) return cache.get(l);
  const file = path.join(REF_DIR, `messages.${l}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(l, data);
  return data;
}

export function t(messages, key, params = {}) {
  const template = messages[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? `{${k}}` : String(params[k])));
}

export function localizeFinding(finding, lang = 'zh', messages = loadMessages(lang)) {
  const out = { ...finding };
  if (finding.messageKey) {
    const base = finding.ruleId || String(finding.messageKey).split('.')[0];
    out.title = t(messages, finding.messageKey, finding.params);
    if (messages[`${base}.observation`]) out.observation = t(messages, `${base}.observation`, finding.params);
    if (messages[`${base}.impact`]) out.impact = t(messages, `${base}.impact`, finding.params);
    if (messages[`${base}.suggestion`]) out.suggestion = t(messages, `${base}.suggestion`, finding.params);
  }
  if (!out.title) out.title = finding.title || finding.ruleId || finding.id || 'Finding';
  return out;
}
