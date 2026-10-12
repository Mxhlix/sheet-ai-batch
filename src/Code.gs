/**
 * AIワークシート — スプレッドシート × 生成AI 一括テキスト処理エンジン（実演サンプル / 再利用エンジン）
 *
 * 何をする:
 *   シートの各行の「入力」列テキストを生成AIで処理し、結果を隣の出力列に書き込む。
 *   TASK_PROMPT（プロンプト）と OUTPUT_FIELDS（出力列）を差し替えるだけで、
 *   分類・要約・抽出・翻訳・添削・下書き など用途が変わる汎用エンジン。
 *
 * 提供元の切り替え:
 *   どの生成AIを使うかは実装都合なので、CONFIG.AI.PROVIDER で切り替える（'gemini' | 'claude'。
 *   新しい提供元も callAi_ に1行足して関数を1つ書けば同じ形で増やせる）。
 *   APIキーはスクリプトプロパティ AI_API_KEY に置く（提供元を変えてもキー名は変わらない）。
 *
 * 構造化出力（この仕組みの核）:
 *   どの提供元でも「OUTPUT_FIELDS をキーに持つ JSON」が返るよう、構造化出力で形を縛る。
 *   スキーマは buildSchema_() の1か所で出力列から組み立て、提供元ごとのペイロード形式へ
 *   変換するだけにしてある（列を足せば両方の提供元のスキーマが自動で追従する）。
 *
 * 正直さ:
 *   これは実演用サンプル(デモ)。DEMO_MODE=true では通信せず簡易ロジックで出力を埋める
 *   （APIキー無しでも動きの形を見せるため）。実データで使うときは、列・プロンプト・提供元を用途に合わせて設定する。
 */

// ==== 設定（本番はここを差し替える。APIキーはスクリプトプロパティ推奨）====
var CONFIG = {
  DEMO_MODE: true,

  SHEET_NAME: 'AIワークシート',
  INPUT_HEADER: '入力',       // この見出しの列を処理対象にする
  OUTPUT_FIELDS: ['カテゴリ', '緊急度', '返信ドラフト'],  // この見出しの列に結果を書く
  MAX_ROWS_PER_RUN: 20,      // 1回で処理する最大行数（コスト/レート保護）

  // 定期自動実行の時間。createTriggers() がこの値でトリガーを作り直す（コード中に直書きしない）。
  //   EVERY_HOURS … 1以上なら、その時間ごとに実行する（残りの行は次の実行で続きから処理する）
  //   DAILY_HOUR  … EVERY_HOURS が 0 のとき、毎日この時台に1回実行する（0〜23。
  //                 Apps Script の仕様で、指定した時の1時間の幅のどこかで動く。例: 9 なら 9時台）
  SCHEDULE: {
    EVERY_HOURS: 1,
    DAILY_HOUR: 9
  },

  // {{input}} が各行のテキストに置き換わる。出力は OUTPUT_FIELDS をキーに持つ JSON で返させる。
  TASK_PROMPT:
    'あなたはカスタマーサポートの一次対応担当です。次の問い合わせを読み、\n' +
    'カテゴリ（例: 返品/不具合/使い方/請求/その他）、緊急度（高/中/低）、\n' +
    'そのまま送れる丁寧な返信ドラフト（120字程度）を作成してください。\n\n' +
    '問い合わせ:\n"""{{input}}"""',

  // 生成AIの設定。PROVIDER: 'gemini' | 'claude'。MODEL は提供元に合わせる
  // （例: gemini-flash-latest / claude-sonnet-5）。提供元・モデルは設置時に選ぶ。
  AI: {
    PROVIDER: 'gemini',
    MODEL: 'gemini-flash-latest',
    MAX_TOKENS: 1024,        // 1行あたりの出力は短い前提。用途に応じて調整
    API_KEY: ''              // 空ならスクリプトプロパティ AI_API_KEY を使う
  }
};

/**
 * シートを開いたときにメニュー「AIワークシート > AIで一括処理」を出す（手動実行の入口）。
 * シート上にボタンを置く場合は、図形に processSheet を割り当てる（手順は README）。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('AIワークシート')
    .addItem('AIで一括処理', 'processSheet')
    .addToUi();
}

/**
 * メイン: 未処理の行を対象に生成AIで処理してシートに書き込む。トリガー・メニュー・ボタンから呼ぶ。
 */
function processSheet() {
  var sheet = getOrCreateSheet_();
  var layout = resolveColumns_(sheet);      // {inputCol, outputCols:{field:colIndex}, headerRow}
  var lastRow = sheet.getLastRow();
  if (lastRow <= layout.headerRow) { Logger.log('データ行がありません'); return; }

  var processed = 0;
  for (var row = layout.headerRow + 1; row <= lastRow; row++) {
    if (processed >= CONFIG.MAX_ROWS_PER_RUN) {
      Logger.log('MAX_ROWS_PER_RUN(%s)に達したので中断。再実行で続きを処理します', CONFIG.MAX_ROWS_PER_RUN);
      break;
    }
    var input = String(sheet.getRange(row, layout.inputCol).getValue() || '').trim();
    if (!input) continue;
    if (rowAlreadyDone_(sheet, row, layout)) continue; // 出力が既に埋まっていれば飛ばす（冪等）

    var result = CONFIG.DEMO_MODE ? demoAnswer_(input) : callAi_(input);
    if (!result) continue; // エラー時は callAi_ 内でログ済み
    writeRow_(sheet, row, layout, result);
    processed++;
  }
  Logger.log('処理完了: %s 行（DEMO_MODE=%s, PROVIDER=%s, MODEL=%s）',
    processed, CONFIG.DEMO_MODE, CONFIG.AI.PROVIDER, CONFIG.AI.MODEL);
}

/**
 * 本番: 1行分を生成AIに投げ、OUTPUT_FIELDS を持つオブジェクトを返す。失敗時 null。
 * 提供元の違いは payload の作り方とレスポンスの取り出し方だけで、返す形は同じ。
 */
function callAi_(input) {
  var key = CONFIG.AI.API_KEY ||
    PropertiesService.getScriptProperties().getProperty('AI_API_KEY');
  if (!key) {
    Logger.log('エラー: APIキー未設定（CONFIG.AI.API_KEY か スクリプトプロパティ AI_API_KEY）');
    return null;
  }
  if (CONFIG.AI.PROVIDER === 'gemini') return callGemini_(input, key);
  if (CONFIG.AI.PROVIDER === 'claude') return callClaude_(input, key);
  Logger.log('エラー: 未対応の提供元です: %s', CONFIG.AI.PROVIDER);
  return null;
}

/** 各行のテキストを差し込んだプロンプト。提供元によらず同じ文面を使う。 */
function buildPrompt_(input) {
  return CONFIG.TASK_PROMPT.replace('{{input}}', input);
}

/**
 * Gemini（generateContent）。
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   ヘッダ: x-goog-api-key（キーはURLに載せない。URLはログに残りやすいため）
 *   generationConfig.responseMimeType='application/json' + responseSchema で
 *   OUTPUT_FIELDS をキーに持つ JSON を受け取る。本文は candidates[0].content.parts[0].text。
 */
function callGemini_(input, key) {
  var payload = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt_(input) }] }],
    generationConfig: {
      maxOutputTokens: CONFIG.AI.MAX_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: geminiSchema_(buildSchema_())
    }
  };
  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.AI.MODEL + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(payload)
  });

  var json = parseJson_(res.getContentText());
  if (!json) return null;
  if (json.error) { Logger.log('APIエラー: %s', JSON.stringify(json.error)); return null; }

  var parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  var text = parts[0] && parts[0].text;
  if (!text) { Logger.log('出力テキストがありません: %s', res.getContentText()); return null; }
  return parseOutput_(text);
}

/**
 * Claude（Messages API・一次確認 2026-07-13）。
 *   POST https://api.anthropic.com/v1/messages
 *   ヘッダ: x-api-key / anthropic-version: 2023-06-01 / content-type: application/json
 *   output_config.format（json_schema）で OUTPUT_FIELDS をキーに持つ JSON を受け取る。
 *   本文は最初の text ブロック。thinking は付けない（単純処理はオフが速く安い）。
 */
function callClaude_(input, key) {
  var payload = {
    model: CONFIG.AI.MODEL,
    max_tokens: CONFIG.AI.MAX_TOKENS,
    messages: [{ role: 'user', content: buildPrompt_(input) }],
    output_config: { format: { type: 'json_schema', schema: buildSchema_() } }
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload)
  });

  var json = parseJson_(res.getContentText());
  if (!json) return null;
  if (json.error) { Logger.log('APIエラー: %s', JSON.stringify(json.error)); return null; }
  if (json.stop_reason === 'refusal') { Logger.log('モデルが応答を拒否しました(refusal)'); return null; }

  var textBlock = (json.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!textBlock) { Logger.log('textブロックがありません: %s', res.getContentText()); return null; }
  return parseOutput_(textBlock.text);
}

/** レスポンス全体のJSON解析。壊れていたらログを残して null。 */
function parseJson_(text) {
  try { return JSON.parse(text); }
  catch (e) { Logger.log('エラー: レスポンスをJSON解析できません: %s', text); return null; }
}

/** 構造化出力の本文（OUTPUT_FIELDS をキーに持つJSON）を解析する。 */
function parseOutput_(text) {
  try { return JSON.parse(text); }
  catch (e) { Logger.log('出力JSONの解析に失敗: %s', text); return null; }
}

/**
 * OUTPUT_FIELDS から JSON Schema を組み立てる（各フィールドは文字列・全て必須）。
 * 構造化出力のスキーマはここ1か所だけ。提供元ごとの差は下の変換関数で吸収する。
 */
function buildSchema_() {
  var props = {};
  CONFIG.OUTPUT_FIELDS.forEach(function (f) { props[f] = { type: 'string' }; });
  return {
    type: 'object',
    properties: props,
    required: CONFIG.OUTPUT_FIELDS.slice(),
    additionalProperties: false
  };
}

/**
 * buildSchema_() の JSON Schema を Gemini の responseSchema 形式へ変換する。
 * 型名が大文字（OBJECT / STRING）で、additionalProperties は受け付けない、という2点だけの違い。
 */
function geminiSchema_(schema) {
  var props = {};
  Object.keys(schema.properties).forEach(function (f) {
    props[f] = { type: String(schema.properties[f].type).toUpperCase() };
  });
  return {
    type: String(schema.type).toUpperCase(),
    properties: props,
    required: schema.required.slice()
  };
}

/**
 * デモ用: 通信せず簡易ロジックで結果を返す（APIキー不要で動きを見せる）。
 * ※ 本番は callAi_ が生成AIの実出力を返します。これはあくまで動作見本です。
 */
function demoAnswer_(input) {
  var t = input;
  var category =
    /返品|返金|キャンセル/.test(t) ? '返品' :
    /動かない|エラー|不具合|壊れ|故障|入りません|起動しない|反応しない|表示されない|映らない|つかない|効かない/.test(t) ? '不具合' :
    /使い方|方法|どうやって|わからない/.test(t) ? '使い方' :
    /請求|支払|料金|引き落と/.test(t) ? '請求' : 'その他';
  var urgency = /至急|今すぐ|すぐに|急ぎ|動かない|エラー|停止|入りません/.test(t) ? '高'
    : /困って|早め|なるべく/.test(t) ? '中' : '低';
  var reply = 'お問い合わせありがとうございます。「' + category +
    '」の件、確認のうえ折り返しご連絡いたします。ご不便をおかけし申し訳ございません。';
  var out = {};
  CONFIG.OUTPUT_FIELDS.forEach(function (f) {
    out[f] = f === 'カテゴリ' ? category : f === '緊急度' ? urgency
      : f === '返信ドラフト' ? reply : '(デモ)';
  });
  return out;
}

// ==== シート操作 ====
function resolveColumns_(sheet) {
  var headerRow = 1;
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { if (h !== '') map[String(h)] = i + 1; });

  var inputCol = map[CONFIG.INPUT_HEADER];
  if (!inputCol) { inputCol = ++lastCol; sheet.getRange(headerRow, inputCol).setValue(CONFIG.INPUT_HEADER); }

  var outputCols = {};
  CONFIG.OUTPUT_FIELDS.forEach(function (f) {
    var c = map[f];
    if (!c) { c = ++lastCol; sheet.getRange(headerRow, c).setValue(f); }
    outputCols[f] = c;
  });
  sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return { inputCol: inputCol, outputCols: outputCols, headerRow: headerRow };
}

function rowAlreadyDone_(sheet, row, layout) {
  return CONFIG.OUTPUT_FIELDS.every(function (f) {
    return String(sheet.getRange(row, layout.outputCols[f]).getValue() || '').trim() !== '';
  });
}

function writeRow_(sheet, row, layout, result) {
  CONFIG.OUTPUT_FIELDS.forEach(function (f) {
    sheet.getRange(row, layout.outputCols[f]).setValue(result[f] != null ? result[f] : '');
  });
}

function getOrCreateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME) || ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0 && CONFIG.DEMO_MODE) ensureDemoData_(sheet);
  return sheet;
}

/** デモ用のサンプル入力（問い合わせ）を用意する。 */
function ensureDemoData_(sheet) {
  sheet.getRange(1, 1).setValue(CONFIG.INPUT_HEADER);
  sheet.getRange(2, 1, 5, 1).setValues([
    ['先週買った商品が届いたのですが、電源が入りません。至急対応してほしいです。'],
    ['注文をキャンセルして返金してもらうことはできますか？'],
    ['アプリの使い方がわからないので教えてください。'],
    ['今月の請求金額がいつもより高い気がします。内訳を知りたいです。'],
    ['いつも利用しています。とても満足しています。ありがとう。']
  ]);
}

/**
 * 定期自動実行のトリガーを CONFIG.SCHEDULE の値で作る（processSheet の既存トリガーは作り直す）。
 * トリガーは作成した本人のアカウントで動くため、実際に使う人が自分で実行する。
 */
function createTriggers() {
  var s = CONFIG.SCHEDULE || {};
  var every = Number(s.EVERY_HOURS || 0);
  var hour = Number(s.DAILY_HOUR);
  if (every !== 0 && !(every >= 1 && Math.floor(every) === every)) {
    throw new Error('CONFIG.SCHEDULE.EVERY_HOURS は 0 か 1 以上の整数で設定してください: ' + s.EVERY_HOURS);
  }
  if (every === 0 && !(hour >= 0 && hour <= 23 && Math.floor(hour) === hour)) {
    throw new Error('CONFIG.SCHEDULE.DAILY_HOUR は 0〜23 の整数で設定してください: ' + s.DAILY_HOUR);
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processSheet') ScriptApp.deleteTrigger(t);
  });
  if (every >= 1) {
    ScriptApp.newTrigger('processSheet').timeBased().everyHours(every).create();
    Logger.log('トリガー作成: %s時間ごとに processSheet を実行', every);
  } else {
    ScriptApp.newTrigger('processSheet').timeBased().everyDays(1).atHour(hour).create();
    Logger.log('トリガー作成: 毎日 %s時台に processSheet を実行', hour);
  }
}
