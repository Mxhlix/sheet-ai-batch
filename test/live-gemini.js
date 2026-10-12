/**
 * live-gemini.js: runs src/Code.gs against the real Gemini API (not part of npm test / CI).
 *
 *   GEMINI_API_KEY=... node test/live-gemini.js
 *
 * Only the spreadsheet is imitated. UrlFetchApp.fetch sends a real HTTPS request with curl,
 * so the request body built by Code.gs is the one Gemini receives.
 * The five demo inquiries are processed with DEMO_MODE off. Rows that fail stay blank and are
 * retried on the next run (up to MAX_RUNS runs, WAIT_SEC apart). The result is written to
 * docs/live-run.json (inputs, outputs, model, date). The key is never written to disk.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY is not set.');
  process.exit(2);
}

function makeSheet(name) {
  const data = [];
  return {
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
    setFrozenRows() { return this; },
    _dump: () => data,
    getRange(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      const cell = (i, j) => { const row = data[r - 1 + i]; return row && row[c - 1 + j] !== undefined ? row[c - 1 + j] : ''; };
      const put = (i, j, v) => {
        while (data.length < r + i) data.push([]);
        const row = data[r - 1 + i];
        while (row.length < c + j) row.push('');
        row[c - 1 + j] = v;
      };
      return {
        getValue: () => cell(0, 0),
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(i, j))),
        setValue(v) { put(0, 0, v); return this; },
        setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => put(i, j, v))); return this; },
        setFontWeight() { return this; }
      };
    }
  };
}

const sheets = new Map();
const ss = {
  getSheetByName: (n) => sheets.get(n) || null,
  insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; }
};

const requests = [];

function fetchWithCurl(url, options) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-gemini-'));
  const bodyFile = path.join(tmp, 'body.json');
  fs.writeFileSync(bodyFile, options.payload, 'utf8');
  // Headers go through curl's config on stdin, so the key is not on the command line.
  const config = Object.entries(options.headers || {})
    .map(([k, v]) => `header = "${k}: ${v}"`)
    .concat([`header = "Content-Type: ${options.contentType || 'application/json'}"`])
    .join('\n');
  try {
    const out = execFileSync('curl', ['-sS', '-X', 'POST', '--data-binary', '@' + bodyFile, '-w', '\n%{http_code}', '-K', '-', url],
      { input: config, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const cut = out.lastIndexOf('\n');
    return { code: Number(out.slice(cut + 1)), text: out.slice(0, cut) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const sandbox = {
  Logger: { log(fmt) { const a = [].slice.call(arguments, 1); let i = 0; console.log(String(fmt).replace(/%s/g, () => String(a[i++]))); } },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (n) => (n === 'AI_API_KEY' ? KEY : null) }) },
  UrlFetchApp: {
    fetch(url, options) {
      const res = fetchWithCurl(url, options);
      requests.push({ url, code: res.code });
      return { getResponseCode: () => res.code, getContentText: () => res.text };
    }
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });

// Put the demo inquiries in the sheet, then process them with the real API.
vm.runInContext('ensureDemoData_(getOrCreateSheet_()); CONFIG.DEMO_MODE = false;', sandbox);

const C = vm.runInContext('CONFIG', sandbox);
const isFilled = (r, header) => C.OUTPUT_FIELDS.every((f) => String(r[header.indexOf(f)] || '') !== '');
const allFilled = () => {
  const rows = sheets.get(C.SHEET_NAME)._dump();
  return rows.slice(1).every((r) => isFilled(r, rows[0]));
};

// Failed rows stay blank and are retried on the next run (the same as a scheduled trigger would).
// Up to MAX_RUNS runs, WAIT_SEC seconds apart.
const MAX_RUNS = Number(process.env.MAX_RUNS || 6);
const WAIT_SEC = Number(process.env.WAIT_SEC || 30);
let runs = 0;
while (runs < MAX_RUNS) {
  runs++;
  console.log(`--- run ${runs}`);
  sandbox.processSheet();
  if (allFilled()) break;
  if (runs < MAX_RUNS) execFileSync(process.execPath, ['-e', `setTimeout(() => {}, ${WAIT_SEC * 1000})`]);
}

const rows = sheets.get(C.SHEET_NAME)._dump();
const header = rows[0];
const result = {
  date: new Date().toISOString().slice(0, 10),
  provider: C.AI.PROVIDER,
  model: C.AI.MODEL,
  runs,
  requests: requests.map((r) => ({ url: r.url, status: r.code })),
  header,
  rows: rows.slice(1)
};
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'live-run.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));

const filled = result.rows.filter((r) => isFilled(r, header));
console.log(`\n${filled.length} / ${result.rows.length} rows filled by ${C.AI.PROVIDER} (${C.AI.MODEL}) in ${runs} run(s).`);
process.exitCode = filled.length === result.rows.length ? 0 : 1;
