# Apps Script への設置

`Code.gs` と `appsscript.json` を、Google スプレッドシートに紐づいた Apps Script プロジェクトに入れて使います。

## デモを動かす

1. Google スプレッドシートを新しく作り、拡張機能 > Apps Script を開きます。
2. 既定のコードを `Code.gs` の中身で置き換えます。`appsscript.json` も同じ内容にします（エディタの設定で「マニフェストを表示」をオンにすると編集できます）。
3. `CONFIG.DEMO_MODE` が `true` のまま、関数 `processSheet` を実行します。初回は権限の許可を求められます。
4. 起きること:
   - 「AIワークシート」シートができ、「入力」列にサンプルの問い合わせが5件入ります。
   - 「カテゴリ」「緊急度」「返信ドラフト」の列が足され、5行すべてが埋まります。
5. デモは通信しません。APIキーも要りません。答えはキーワードの簡単な規則で作るので、生成AIの出力とは違います。

2回目からは、シートを開き直すと出るメニュー「AIワークシート」>「AIで一括処理」からも実行できます。

## 生成AIにつなぐ

1. 使う提供元の APIキーを用意します。
2. Apps Script のプロジェクトの設定 > スクリプト プロパティに、名前 `AI_API_KEY` でキーを保存します。コードには書きません。
3. `CONFIG` を次のように設定します。
   - `DEMO_MODE`: `false`
   - `AI.PROVIDER`: `'gemini'`（既定）か `'claude'`
   - `AI.MODEL`: 提供元に合わせたモデル名（例: `gemini-flash-latest` / `claude-sonnet-5`）
   - `AI.MAX_TOKENS`: 1行あたりの出力の上限（既定 1024）
4. 関数 `processSheet` を実行します。入力のある行のうち、出力列がまだ埋まっていない行だけを送ります。

## 用途を変える

`CONFIG` の次の値を変えます。

- `INPUT_HEADER`: 処理する入力列の見出し（既定「入力」）
- `OUTPUT_FIELDS`: 結果を書く出力列の見出し（配列）。無い列は見出しが自動で足されます。
- `TASK_PROMPT`: やらせたい処理の指示。`{{input}}` が各行のテキストに置き換わります。
- `MAX_ROWS_PER_RUN`: 1回で送る行数の上限（既定 20）。残りは次の実行で続きから処理します。

出力は `OUTPUT_FIELDS` をキーに持つ JSON で返るよう、構造化出力で形を決めています。列を変えるとスキーマも変わるので、ほかのコードを触る必要はありません。

変え方の例:

- 口コミの分析: 入力 = 口コミ / 出力 = 感情・論点・要約
- 商品説明の作成: 入力 = 商品名と仕様 / 出力 = 説明文・タイトル
- 翻訳と添削: 入力 = 原文 / 出力 = 訳文・修正版

## シートにボタンを置く

1. 挿入 > 図形描画 でボタンにする図形を作って保存します。
2. 図形を選び、右上の︙から「スクリプトを割り当て」を選んで `processSheet` と入力します。

以後は図形を押すと実行されます。

## 決まった間隔の自動実行

1. `CONFIG.SCHEDULE` に間隔を書きます。
   - `EVERY_HOURS`: 1 以上の整数なら、その時間ごとに実行します（既定 1）。
   - `DAILY_HOUR`: `EVERY_HOURS` が 0 のとき、毎日この時台に1回実行します（0〜23、既定 9）。
2. 関数 `createTriggers` を実行します。`processSheet` の既存のトリガーを消して作り直します。ほかの関数のトリガーには触れません。

毎日の時台指定は、Apps Script の仕様で、その1時間のどこかで動きます（9 なら 9時台）。
値が正しくないときは、トリガーを作らずにエラーになります。
トリガーは作った人のアカウントで動くので、実際に使う人が自分で `createTriggers` を実行します。

## 構造化出力のしくみ

スキーマは `buildSchema_()` が `OUTPUT_FIELDS` から作る1か所だけです。
提供元ごとの違いは、そのスキーマの載せ方と、応答からの取り出し方だけです。

| 提供元 | 呼び出し | 構造化出力の指定 | 本文の取り出し |
|---|---|---|---|
| Gemini | `POST …/v1beta/models/{model}:generateContent`（ヘッダ `x-goog-api-key`） | `generationConfig.responseMimeType='application/json'` + `responseSchema` | `candidates[0].content.parts[0].text` |
| Claude | `POST https://api.anthropic.com/v1/messages`（ヘッダ `x-api-key` / `anthropic-version`） | `output_config.format`（`json_schema`） | 最初の `text` ブロック |

Claude には thinking の指定を付けていません。

## ローカルでのテスト

リポジトリの一番上で次を実行します。

```
npm test
```

`Code.gs` をそのまま読み込み、GAS の機能を模擬して動かします。本物の API は呼びません。
