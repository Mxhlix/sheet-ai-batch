/**
 * run-tests.js: 実APIを呼ばないローカル検証ハーネス（Node.js・標準モジュールのみ）
 *
 * 目的:
 *   GAS用の Code.gs を Node で読み込み、GASのグローバル（SpreadsheetApp / Logger /
 *   PropertiesService / UrlFetchApp）をモックして、
 *   (a) 提供元ごとのリクエストに「出力列どおりのキーを持つJSON」を強制する構造化出力が載るか
 *   (b) 既定の提供元・キー名（AI_API_KEY）
 *   (c) 処理フロー（デモ処理 / MAX_ROWS_PER_RUN の中断と再実行での続きから / 冪等スキップ / 書き込み）
 *   を検証する。実APIキーも実通信もスプレッドシートも不要。
 *
 * 実行:  npm test（または node test/run-tests.js）
 * 期待:  すべて [PASS] で終了コード 0。1つでも失敗すると終了コード 1。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');

// ---- GASグローバルのモック --------------------------------------------------

function makeSpreadsheetApp() {
  const sheets = new Map();
  function makeSheet(name) {
    const data = []; // 行の配列（各行はセルの配列）
    return {
      getName() { return name; },
      getLastRow() { return data.length; },
      getLastColumn() { return data.reduce((m, r) => Math.max(m, r.length), 0); },
      setFrozenRows() { return this; },
      _dump() { return data; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValue() {
            const row = data[r - 1];
            return row && row[c - 1] !== undefined ? row[c - 1] : '';
          },
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = [];
              for (let j = 0; j < nc; j++) {
                const rr = data[r - 1 + i];
                row.push(rr && rr[c - 1 + j] !== undefined ? rr[c - 1 + j] : '');
              }
              out.push(row);
            }
            return out;
          },
          setValue(v) {
            while (data.length < r) data.push([]);
            const row = data[r - 1];
            while (row.length < c) row.push('');
            row[c - 1] = v;
            return this;
          },
          setValues(vals) {
            for (let i = 0; i < vals.length; i++) {
              while (data.length < r + i) data.push([]);
              const row = data[r - 1 + i];
              for (let j = 0; j < vals[i].length; j++) {
                while (row.length < c + j) row.push('');
                row[c - 1 + j] = vals[i][j];
              }
            }
            return this;
          },
          setFontWeight() { return this; }
        };
      }
    };
  }
  const ss = {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) { const s = makeSheet(name); sheets.set(name, s); return s; }
  };
  return { getActiveSpreadsheet() { return ss; }, _ss: ss };
}

/**
 * Code.gs を新しいサンドボックスに読み込む。
 * opts.apiKey       … スクリプトプロパティ AI_API_KEY の値（null で未設定）
 * opts.responseFor  … (url, options) => レスポンス本文の文字列
 */
function load(opts) {
  opts = opts || {};
  const logs = [];
  const fetches = [];
  const propsAsked = [];
  const props = Object.prototype.hasOwnProperty.call(opts, 'apiKey') ? opts.apiKey : 'test-key-xxx';
  const SpreadsheetApp = makeSpreadsheetApp();
  const menus = [];      // onOpen() が作ったメニュー {name, items:[[label, fn]]}
  const triggers = [];   // createTriggers() が作ったトリガー {handler, everyHours, everyDays, atHour}
  let deleted = 0;       // 作り直しで消したトリガーの数
  const existing = (opts.existingTriggers || []).map(h => ({ getHandlerFunction: () => h }));
  SpreadsheetApp.getUi = () => ({
    createMenu(name) {
      const m = { name, items: [] };
      const b = { addItem(label, fn) { m.items.push([label, fn]); return b; }, addToUi() { menus.push(m); } };
      return b;
    }
  });
  const ScriptApp = {
    getProjectTriggers: () => existing,
    deleteTrigger() { deleted++; },
    newTrigger(handler) {
      const rec = { handler, everyHours: null, everyDays: null, atHour: null };
      const b = {
        timeBased: () => b,
        everyHours: (n) => { rec.everyHours = n; return b; },
        everyDays: (n) => { rec.everyDays = n; return b; },
        atHour: (h) => { rec.atHour = h; return b; },
        create: () => { triggers.push(rec); return b; }
      };
      return b;
    }
  };

  const sandbox = {
    Logger: {
      log(fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        let i = 0;
        logs.push(String(fmt).replace(/%s/g, () => (i < args.length ? String(args[i++]) : '%s')));
      }
    },
    SpreadsheetApp,
    ScriptApp,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty(name) { propsAsked.push(name); return name === 'AI_API_KEY' ? props : null; }
      })
    },
    UrlFetchApp: {
      fetch(url, options) {
        const req = { url, options, payload: JSON.parse(options.payload) };
        fetches.push(req);
        const body = opts.responseFor ? opts.responseFor(url, options) : '{}';
        return { getContentText: () => body, getResponseCode: () => 200 };
      }
    },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'Code.gs' });
  return { sandbox, logs, fetches, propsAsked, SpreadsheetApp, menus, triggers, deletedCount: () => deleted };
}

/** 本番モードで processSheet を回すためのシート下ごしらえ（入力列＋入力行）。 */
function seedSheet(env, inputs) {
  const sh = env.SpreadsheetApp._ss.insertSheet(env.sandbox.CONFIG.SHEET_NAME);
  sh.getRange(1, 1).setValue(env.sandbox.CONFIG.INPUT_HEADER);
  sh.getRange(2, 1, inputs.length, 1).setValues(inputs.map(t => [t]));
  return sh;
}

/** 出力列3つが埋まっている行数（ヘッダ行を除く）。 */
function filledRows(env, sh) {
  const layout = env.sandbox.resolveColumns_(sh);
  let n = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) {
    const done = env.sandbox.CONFIG.OUTPUT_FIELDS.every(
      f => String(sh.getRange(r, layout.outputCols[f]).getValue() || '').trim() !== '');
    if (done) n++;
  }
  return n;
}

// ---- 検証ユーティリティ -----------------------------------------------------

let pass = 0, fail = 0;
function ok(label, fn) {
  try { fn(); pass++; console.log('[PASS] ' + label); }
  catch (e) { fail++; console.log('[FAIL] ' + label + '\n        ' + e.message); }
}
const FIELDS = ['カテゴリ', '緊急度', '返信ドラフト'];
const geminiBody = obj => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const claudeBody = obj => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const sample = { 'カテゴリ': '不具合', '緊急度': '高', '返信ドラフト': 'ご連絡ありがとうございます。' };
// サンドボックス内で作られたオブジェクトは prototype が別realmになるため、素の値へ均す
const plain = o => JSON.parse(JSON.stringify(o));

// ---- A. 既定設定 ------------------------------------------------------------

console.log('\n== A. 既定設定 ==');
{
  const env = load({});
  const C = env.sandbox.CONFIG;
  ok('既定の提供元が gemini', () => assert.strictEqual(C.AI.PROVIDER, 'gemini'));
  ok('既定モデルが提供元に整合（gemini-）', () => assert.ok(/^gemini-/.test(C.AI.MODEL), C.AI.MODEL));
  ok('CONFIG にベンダー固有のキー設定が残っていない', () => {
    assert.ok(!('API_KEY' in C), 'CONFIG.API_KEY が残っている');
    assert.ok(!('API_VERSION' in C), 'CONFIG.API_VERSION が残っている');
    assert.ok(!('MODEL' in C), 'CONFIG.MODEL が残っている');
  });
}

// ---- B. Gemini向けペイロード ------------------------------------------------

console.log('\n== B. Gemini向けペイロード ==');
{
  const env = load({ responseFor: () => geminiBody(sample) });
  const out = env.sandbox.callAi_('電源が入りません。至急お願いします。');
  const req = env.fetches[0];
  const p = req.payload;

  ok('中立キー名 AI_API_KEY を読む', () => assert.deepStrictEqual(env.propsAsked, ['AI_API_KEY']));
  ok('URL に generateContent とモデル名が入る', () => {
    assert.ok(req.url.indexOf(':generateContent') > 0, req.url);
    assert.ok(req.url.indexOf(env.sandbox.CONFIG.AI.MODEL) > 0, req.url);
  });
  ok('キーはヘッダ x-goog-api-key で渡す（URLに載せない）', () => {
    assert.strictEqual(req.options.headers['x-goog-api-key'], 'test-key-xxx');
    assert.ok(req.url.indexOf('test-key-xxx') === -1, 'キーがURLに載っている');
  });
  ok('responseMimeType が application/json', () =>
    assert.strictEqual(p.generationConfig.responseMimeType, 'application/json'));
  ok('responseSchema がある', () => assert.ok(p.generationConfig.responseSchema));
  ok('responseSchema のキーが出力列と一致', () =>
    assert.deepStrictEqual(Object.keys(p.generationConfig.responseSchema.properties), FIELDS));
  ok('responseSchema の型が Gemini 形式（OBJECT / STRING）', () => {
    const s = p.generationConfig.responseSchema;
    assert.strictEqual(s.type, 'OBJECT');
    FIELDS.forEach(f => assert.strictEqual(s.properties[f].type, 'STRING'));
  });
  ok('required が出力列と一致', () =>
    assert.deepStrictEqual(p.generationConfig.responseSchema.required, FIELDS));
  ok('Gemini が受け付けない additionalProperties を送らない', () =>
    assert.ok(!('additionalProperties' in p.generationConfig.responseSchema)));
  ok('maxOutputTokens に CONFIG.AI.MAX_TOKENS', () =>
    assert.strictEqual(p.generationConfig.maxOutputTokens, env.sandbox.CONFIG.AI.MAX_TOKENS));
  ok('プロンプトに行のテキストが差し込まれる', () => {
    const t = p.contents[0].parts[0].text;
    assert.ok(t.indexOf('電源が入りません') > 0, t.slice(0, 80));
    assert.ok(t.indexOf('{{input}}') === -1, '{{input}} が残っている');
  });
  ok('レスポンスから出力列どおりのオブジェクトを取り出す', () => assert.deepStrictEqual(plain(out), sample));
}

// ---- C. Claude向けペイロード ------------------------------------------------

console.log('\n== C. Claude向けペイロード ==');
{
  const env = load({ responseFor: () => claudeBody(sample) });
  env.sandbox.CONFIG.AI.PROVIDER = 'claude';
  env.sandbox.CONFIG.AI.MODEL = 'claude-sonnet-5';
  const out = env.sandbox.callAi_('注文をキャンセルしたいです。');
  const req = env.fetches[0];
  const p = req.payload;
  const schema = p.output_config.format.schema;

  ok('URL が Messages API', () =>
    assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages'));
  ok('ヘッダが x-api-key / anthropic-version', () => {
    assert.strictEqual(req.options.headers['x-api-key'], 'test-key-xxx');
    assert.strictEqual(req.options.headers['anthropic-version'], '2023-06-01');
  });
  ok('model / max_tokens が CONFIG.AI から', () => {
    assert.strictEqual(p.model, 'claude-sonnet-5');
    assert.strictEqual(p.max_tokens, env.sandbox.CONFIG.AI.MAX_TOKENS);
  });
  ok('構造化出力が json_schema', () =>
    assert.strictEqual(p.output_config.format.type, 'json_schema'));
  ok('schema のキーが出力列と一致', () =>
    assert.deepStrictEqual(Object.keys(schema.properties), FIELDS));
  ok('schema が現行同等（object / string / required / additionalProperties:false）', () => {
    assert.strictEqual(schema.type, 'object');
    FIELDS.forEach(f => assert.strictEqual(schema.properties[f].type, 'string'));
    assert.deepStrictEqual(schema.required, FIELDS);
    assert.strictEqual(schema.additionalProperties, false);
  });
  ok('プロンプトに行のテキストが差し込まれる', () =>
    assert.ok(p.messages[0].content.indexOf('注文をキャンセル') > 0));
  ok('レスポンスから出力列どおりのオブジェクトを取り出す', () => assert.deepStrictEqual(plain(out), sample));
}

// ---- D. 出力列を差し替えると両提供元のスキーマが追従する --------------------

console.log('\n== D. 出力列の差し替え追従 ==');
{
  const cols = ['感情', '論点', '要約'];
  const envG = load({ responseFor: () => geminiBody({}) });
  envG.sandbox.CONFIG.OUTPUT_FIELDS = cols.slice();
  envG.sandbox.callAi_('口コミ本文');
  ok('Gemini: 新しい列名がスキーマに載る', () => {
    const s = envG.fetches[0].payload.generationConfig.responseSchema;
    assert.deepStrictEqual(Object.keys(s.properties), cols);
    assert.deepStrictEqual(s.required, cols);
  });

  const envC = load({ responseFor: () => claudeBody({}) });
  envC.sandbox.CONFIG.OUTPUT_FIELDS = cols.slice();
  envC.sandbox.CONFIG.AI.PROVIDER = 'claude';
  envC.sandbox.callAi_('口コミ本文');
  ok('Claude: 新しい列名がスキーマに載る', () => {
    const s = envC.fetches[0].payload.output_config.format.schema;
    assert.deepStrictEqual(Object.keys(s.properties), cols);
    assert.deepStrictEqual(s.required, cols);
  });
}

// ---- E. 異常系 --------------------------------------------------------------

console.log('\n== E. 異常系 ==');
{
  const env = load({ apiKey: null });
  ok('APIキー未設定なら通信せず null', () => {
    assert.strictEqual(env.sandbox.callAi_('x'), null);
    assert.strictEqual(env.fetches.length, 0);
    assert.ok(env.logs.join('\n').indexOf('AI_API_KEY') >= 0, env.logs.join('\n'));
  });
}
{
  const env = load({});
  env.sandbox.CONFIG.AI.PROVIDER = 'unknown-vendor';
  ok('未対応の提供元なら通信せず null', () => {
    assert.strictEqual(env.sandbox.callAi_('x'), null);
    assert.strictEqual(env.fetches.length, 0);
  });
}
{
  const env = load({ responseFor: () => JSON.stringify({ error: { message: 'boom' } }) });
  ok('APIエラー応答なら null（Gemini）', () => assert.strictEqual(env.sandbox.callAi_('x'), null));
}
{
  const env = load({ responseFor: () => 'not json' });
  ok('壊れた応答なら null', () => assert.strictEqual(env.sandbox.callAi_('x'), null));
}

// ---- F. 処理フロー（既存挙動が変わっていないこと）---------------------------

console.log('\n== F. 処理フロー ==');
{
  const env = load({});
  env.sandbox.processSheet();
  const sh = env.SpreadsheetApp._ss.getSheetByName(env.sandbox.CONFIG.SHEET_NAME);
  ok('DEMO_MODE: サンプル5行が生成され通信せず全行埋まる', () => {
    assert.strictEqual(sh.getLastRow(), 6); // ヘッダ+5行
    assert.strictEqual(filledRows(env, sh), 5);
    assert.strictEqual(env.fetches.length, 0);
  });
  ok('DEMO_MODE: 出力列3つが自動生成される', () => {
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    assert.deepStrictEqual(headers, ['入力'].concat(FIELDS));
  });
}
{
  const env = load({});
  env.sandbox.CONFIG.MAX_ROWS_PER_RUN = 2;
  env.sandbox.processSheet();
  const sh = env.SpreadsheetApp._ss.getSheetByName(env.sandbox.CONFIG.SHEET_NAME);
  ok('MAX_ROWS_PER_RUN=2 で2行だけ処理して中断', () => {
    assert.strictEqual(filledRows(env, sh), 2);
    assert.ok(env.logs.join('\n').indexOf('MAX_ROWS_PER_RUN') >= 0);
  });
  env.sandbox.processSheet();
  ok('再実行で続きから2行（済み行はスキップ・冪等）', () => assert.strictEqual(filledRows(env, sh), 4));
  env.sandbox.processSheet();
  ok('3回目で残り1行を処理して完了', () => assert.strictEqual(filledRows(env, sh), 5));
}
{
  const env = load({ responseFor: () => geminiBody(sample) });
  env.sandbox.CONFIG.DEMO_MODE = false;
  const sh = seedSheet(env, ['電源が入りません', '返金したい', '']);
  env.sandbox.processSheet();
  ok('本番モード: 入力のある行だけ1行1回ずつ呼ぶ（空行は飛ばす）', () =>
    assert.strictEqual(env.fetches.length, 2));
  ok('本番モード: レスポンスが出力列に書かれる', () => {
    const layout = env.sandbox.resolveColumns_(sh);
    assert.strictEqual(sh.getRange(2, layout.outputCols['カテゴリ']).getValue(), '不具合');
    assert.strictEqual(sh.getRange(3, layout.outputCols['返信ドラフト']).getValue(), sample['返信ドラフト']);
  });
  env.sandbox.processSheet();
  ok('本番モード: 済み行は再送しない（追加の通信なし）', () =>
    assert.strictEqual(env.fetches.length, 2));
}

// ---- G. 手動実行の入口（メニュー）と定期自動実行の時間 -----------------------

console.log('\n== G. メニューと定期自動実行 ==');
{
  const env = load({});
  env.sandbox.onOpen();
  ok('onOpen でメニュー「AIワークシート > AIで一括処理」が出て processSheet を呼ぶ', () => {
    assert.strictEqual(env.menus.length, 1);
    assert.strictEqual(env.menus[0].name, 'AIワークシート');
    assert.deepStrictEqual(plain(env.menus[0].items), [['AIで一括処理', 'processSheet']]);
  });
}
{
  const env = load({ existingTriggers: ['processSheet', 'otherFn'] });
  env.sandbox.createTriggers();
  ok('既定（EVERY_HOURS=1）は1時間ごとのトリガーを1つ作る', () => {
    assert.strictEqual(env.triggers.length, 1);
    assert.strictEqual(env.triggers[0].handler, 'processSheet');
    assert.strictEqual(env.triggers[0].everyHours, 1);
  });
  ok('processSheet の既存トリガーだけを作り直す（他の関数のトリガーは消さない）', () =>
    assert.strictEqual(env.deletedCount(), 1));
}
{
  const env = load({});
  env.sandbox.CONFIG.SCHEDULE = { EVERY_HOURS: 0, DAILY_HOUR: 9 };
  env.sandbox.createTriggers();
  ok('EVERY_HOURS=0 なら毎日 DAILY_HOUR 時台のトリガーを作る', () => {
    assert.strictEqual(env.triggers.length, 1);
    assert.strictEqual(env.triggers[0].everyDays, 1);
    assert.strictEqual(env.triggers[0].atHour, 9);
    assert.strictEqual(env.triggers[0].everyHours, null);
  });
}
{
  const env = load({});
  env.sandbox.CONFIG.SCHEDULE = { EVERY_HOURS: 4, DAILY_HOUR: 9 };
  env.sandbox.createTriggers();
  ok('EVERY_HOURS=4 なら4時間ごとのトリガーを作る', () => assert.strictEqual(env.triggers[0].everyHours, 4));
}
{
  const env = load({});
  env.sandbox.CONFIG.SCHEDULE = { EVERY_HOURS: 0, DAILY_HOUR: 24 };
  ok('DAILY_HOUR が 0〜23 の外なら例外（トリガーを作らない）', () => {
    assert.throws(() => env.sandbox.createTriggers(), /DAILY_HOUR/);
    assert.strictEqual(env.triggers.length, 0);
  });
}
{
  const env = load({});
  env.sandbox.CONFIG.SCHEDULE = { EVERY_HOURS: 1.5, DAILY_HOUR: 9 };
  ok('EVERY_HOURS が整数でなければ例外', () => assert.throws(() => env.sandbox.createTriggers(), /EVERY_HOURS/));
}

// ---- 結果 -------------------------------------------------------------------

console.log('\n' + (fail === 0 ? 'すべて成功' : '失敗あり') + `: PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
