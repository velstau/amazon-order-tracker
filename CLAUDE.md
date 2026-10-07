# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Amazon Order Tracker：amazon.co.jp の注文履歴を取得し、月別支出・注文一覧・配達状況を表示する Chrome 拡張。Manifest V3・素の JS/HTML/CSS でビルドはない。**リポジトリ直下がそのまま拡張のフォルダ**で、Chrome の「パッケージ化されていない拡張機能を読み込む」で直接読み込める。MIT。

UI の文字サイズは最低 1.0rem にする（ユーザーの必須要望）。

## コマンド

ホストに node はない。node は使い捨てコンテナで動かす。

```sh
# JS の構文チェック
docker run --rm -v "$PWD":/w -w /w node:24-alpine node --check <file>.js

# テスト（リポジトリ直下で実行）
docker run --rm -v "$PWD":/src:ro node:24-alpine sh -c 'cp -r /src /w && cd /w \
  && npm i --silent --no-save jsdom@26 fake-indexeddb \
  && PARSER_PATH=/w/parser.js node tests/test_parser.js \
  && node tests/test_dashboard.js'
```

- 片方だけ動かすときは最後の 2 行のどちらかを残す。`test_parser.js` は samples/ の全 HTML の解析結果を出力し、最後に `unit tests ok` を出す（samples/ がなければ単体テストだけ）。`test_dashboard.js` は samples/ が必要で、`dashboard tests ok` で終わる（途中のスタックトレースはエラー表示を検証するテストの想定内の出力）
- jsdom は 26 に固定する。27 以降は `VirtualConsole.sendTo` がなくテストが落ちる
- `test_parser.js` は `require('./parser.js')` がテストファイル基準で解決されるため `PARSER_PATH` が必要。`test_dashboard.js` はカレントディレクトリ基準で `dashboard.html` などを読む
- `samples/` は個人情報を含む実際の注文履歴 HTML と、それに基づくテストの期待値（`samples/expected.json`）。`.gitignore` で除外している。マウントは読み取り専用・`--rm` のコンテナに限り、外部に出さない。**実データ由来の値（金額・件数・商品名・注文番号）をテストや文書に直接書かない**（期待値は expected.json に置く）

## アーキテクチャ

仕様・決定事項・経緯は `docs/HANDOFF.md` にある。挙動を変えたらこの引継書も更新する。

- **処理はすべて拡張ページ（dashboard.html）で行う。** Service Worker では `DOMParser` が使えないため、`background.js` はアイコンクリックでダッシュボードを開くだけ
- `dashboard.html` が `parser.js` → `db.js` → `sync.js` → `dashboard.js` の順に読み込む。各ファイルは IIFE で 1 つのグローバル（`AmazonParser`・`OrderDB`・`OrderSync`）を公開し、後のファイルがそれを使う。モジュールシステムはない
- 取得は拡張ページから `fetch(url, { credentials: 'include' })`（host_permissions により Cookie 付きになる）。URL には必ず `disableCsd=no-js` を付ける。付けないと注文カードの中身が暗号化されたページが返り、パーサーは `encrypted: true` を返す。暗号の復号は意図的に実装しない
- `parser.js` に Amazon の DOM 依存を集約し、セレクタは冒頭の `SELECTORS` にまとめてある。Amazon のページ構造が変わったら、まずここを直す。DOM 構造は推測せず、実際に保存した HTML で確定する
- 同期は「全期間」（年一覧の全年）と「最新分」（直近 90 日の未確定の注文だけを読み直し、DB と同じ内容のページに達したらその年を終える）の 2 種類。ページごとに IndexedDB へ `orderId` で upsert するため、途中で止まっても取得済みの分は残る。ページ間に 1.5 秒＋ゆらぎの待機を入れる（`WAIT_MS`）。ダッシュボードを開いたとき、前回の同期の試行から 1 時間以上たっていれば最新分の同期が自動で走る
- グラフは SVG でなく HTML/CSS で描く（viewBox の縮小で文字が 1rem 未満になるのを避けるため）

## 配布

- 配布は Chrome ウェブストアではなく、vel.works の紹介ページ（https://vel.works/chrome_ext/amazon_order_tracker/）からの zip。`python3 scripts/release.py [--publish]` で `dist/amazon_order_tracker-<版>.zip` を作る（LICENSE は入れ、テスト・文書・スクリプトは入れない）。`--publish` で vel.works の紹介ページのフォルダ（`/var/docker/docker-shared/dev-server-php8/vel.works/chrome_ext/amazon_order_tracker/`）に置き、古い zip を消す
- 版を上げるときに直すもの: `manifest.json` の `version`、`CHANGELOG.md`、vel.works の紹介ページ（`<!-- download:start -->` と `<!-- changelog:start -->` の欄、仕様の札の「バージョン」の `<dd>`）と `vel.works/_build/data/catalog.json` の version。仕様の札の版は catalog.json からビルドで入らないので手で直す。そのあと vel.works をビルドして `chrome_ext` と `top` を本番へ反映する（手順は `dev-server-php8/CLAUDE.md`）。git では `v<版>` のタグを付けて push する
- **manifest の `key` を消したり変えたりしない。** 拡張 ID を固定する公開鍵で、変わると利用者の保存データが消える。対応する秘密鍵はリポジトリの外（`~/.config/velworks/chromeext-keys/`）にあり、ウェブストアに出すときだけ使う
- 公開リポジトリ（GitHub）。コミットの前に、追跡対象に個人情報（実データ、個人のメールアドレスなど）が入っていないか確かめる（開発サーバー上のパスは作業に必要なので可。ホスト名・IP アドレス・認証情報は不可）。作者は `velstau <velstau@users.noreply.github.com>`（リポジトリの設定）
