const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

function camelize(row) {
  if (!row || typeof row !== 'object' || row instanceof Date) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
}

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/** {camelKey: value} 를 SQL SET 절로 변환. map: camelKey -> column */
function buildSet(fields, map) {
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] !== undefined) {
      sets.push(`${col} = ?`);
      const v = fields[k];
      params.push(v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
    }
  }
  return { sql: sets.join(', '), params };
}

/** 두 구간 [aStart,aEnd) 와 [bStart,bEnd) 가 겹치는지 */
const overlaps = (aStart, aEnd, bStart, bEnd) => new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);

const csvEscape = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return '﻿' + [header, ...body].join('\n');
}

module.exports = { camelize, pick, buildSet, overlaps, toCsv };
