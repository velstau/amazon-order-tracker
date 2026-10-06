// tests/test_dashboard.js
// 同期処理とダッシュボード表示を通しで検証する（Node + jsdom + fake-indexeddb）
// fetch を差し替えて samples/ の HTML を返す。待機時間は 0 にする
// samples/（実際の注文履歴 HTML と期待値 expected.json）は個人情報を含むのでリポジトリに入れていない。手元にある場合だけ動く
// 実行方法はリポジトリ直下の CLAUDE.md（amazon_order_tracker/ で node tests/test_dashboard.js）

const fs = require('fs');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');
const quiet = new VirtualConsole(); // Amazon の CSS を jsdom が解析できない警告を抑える
quiet.sendTo(console, { omitJSDOMErrors: true });
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

const read = (f) => fs.readFileSync(f, 'utf8');
// 期待値は実データ由来なので、samples/ と一緒にリポジトリの外に置いてある
const expected = JSON.parse(read('samples/expected.json'));
const p1 = read('samples/orders_method1_nojs_p1_2026.html');
const p2 = read('samples/orders_method1_nojs_p2_2026.html');
const lastPage = p2.replace(/<li class="a-last">[\s\S]*?<\/li>/, '<li class="a-disabled a-last">次へ→</li>');
const emptyPage = (() => {
  const d = new JSDOM(p1, { virtualConsole: quiet }).window.document;
  d.querySelectorAll('.order-card, .a-pagination').forEach((e) => e.remove());
  return d.documentElement.outerHTML;
})();

async function main() {
  const dom = new JSDOM(read('dashboard.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'chrome-extension://test/dashboard.html', virtualConsole: quiet });
  const w = dom.window;
  w.indexedDB = indexedDB;
  w.IDBKeyRange = IDBKeyRange;
  w.confirm = () => true;
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn) => realSetTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};

  let requests = [];
  let route = null; // テストごとに差し替える
  w.fetch = async (url) => {
    requests.push(url);
    const r = route(url);
    return { url: r.url || url, ok: (r.status || 200) === 200, status: r.status || 200, text: async () => r.html };
  };
  const normalRoute = (url) => {
    const u = new URL(url);
    assert.strictEqual(u.searchParams.get('disableCsd'), 'no-js', `disableCsd が付いていない：${url}`);
    if (u.searchParams.get('timeFilter') !== 'year-2026') return { html: emptyPage };
    const page = u.searchParams.get('page');
    return { html: !page ? p1 : page === '1' ? p2 : lastPage };
  };

  // ブラウザの <script> は最上位の const を共有するので、まとめて 1 回で評価する
  // テストから DB を触れるよう OrderDB を外に出す
  w.eval([...['parser.js', 'db.js', 'sync.js', 'dashboard.js'].map(read), 'window.__test = { OrderDB };'].join('\n;\n'));
  const { OrderDB } = w.__test;
  const $ = (id) => w.document.getElementById(id);
  const flush = () => new Promise((r) => setTimeout(r, 50));
  const waitSync = async () => { for (let i = 0; i < 200 && !$('sync-abort').hidden; i++) await flush(); await flush(); };
  await flush();
  assert.match($('orders-body').textContent, /全期間を同期/);
  assert.strictEqual(requests.length, 0, 'データが空のときは自動同期しない');

  // 1. 全期間：今年は複数ページ、それより前の年は各 1 ページ
  route = normalRoute;
  $('sync-full').click();
  await waitSync();
  console.log('full: requests', requests.length, '/', $('sync-status').textContent);
  assert.strictEqual($('sync-error').hidden, true, $('sync-error').textContent);
  assert.strictEqual(requests.length, expected.fullSyncRequests);
  assert.strictEqual($('kpi-this-month').textContent, expected.thisMonth);
  assert.strictEqual($('kpi-last-month').textContent, expected.lastMonth); // キャンセルを除く
  assert.ok($('kpi-last-month-sub').textContent.includes(`${expected.lastMonthCount} 件`));
  assert.strictEqual($('pending-list').querySelectorAll('.pending-item').length, expected.pending);
  assert.strictEqual($('orders-body').querySelectorAll('tr').length, expected.rows);
  assert.ok($('orders-summary').textContent.includes(expected.summary));
  const tableText = $('monthly-table').textContent;
  for (const row of expected.monthlyTable) assert.ok(tableText.includes(row), row);

  // 2. 最新分：1 ページ目は未配達を含むので続行、2 ページ目は確定済みのみで最古の未配達より古い → 停止
  requests = [];
  $('sync-recent').click();
  await waitSync();
  console.log('recent: requests', requests.length, requests.map((u) => new URL(u).searchParams.get('page') || '0'));
  assert.strictEqual(requests.length, 2);

  // 3. 絞り込み
  $('filter-month').value = expected.filterMonth;
  $('filter-month').dispatchEvent(new w.Event('change'));
  assert.strictEqual($('orders-body').querySelectorAll('tr').length, expected.filterMonthRows);
  $('filter-month').value = '';
  $('filter-month').dispatchEvent(new w.Event('change'));
  $('filter-pending').checked = true;
  $('filter-pending').dispatchEvent(new w.Event('change'));
  assert.strictEqual($('orders-body').querySelectorAll('tr').length, expected.pending);
  $('filter-pending').checked = false;
  $('filter-pending').dispatchEvent(new w.Event('change'));
  $('filter-keyword').value = expected.keyword;
  $('filter-keyword').dispatchEvent(new w.Event('input'));
  assert.strictEqual($('orders-body').querySelectorAll('tr').length, expected.keywordRows);

  // 4. 棒グラフ：12 本、月の棒を押すとその月で絞り込む
  const slots = $('chart-plot').querySelectorAll('.chart__slot');
  assert.strictEqual(slots.length, 12);
  const yLabels = [...$('chart-y').children].map((e) => e.textContent);
  console.log('y ticks', yLabels.join(' '));
  slots[expected.chartSlotMonth[0]].click();
  assert.strictEqual($('filter-month').value, expected.chartSlotMonth[1]);

  // 5. ログイン切れ・暗号化ページはエラー表示
  route = (url) => ({ url: 'https://www.amazon.co.jp/ap/signin?x', html: '<form name="signIn"></form>' });
  $('sync-recent').click();
  await waitSync();
  assert.strictEqual($('sync-error').hidden, false);
  console.log('signin:', $('sync-error').textContent);
  route = () => ({ html: read('samples/orders_method1_新形式_2026.html') });
  $('sync-recent').click();
  await waitSync();
  console.log('encrypted:', $('sync-error').textContent);
  assert.match($('sync-error').textContent, /暗号化/);

  // 6. 自動同期：前回の試行から 1 時間以内なら何もしない、過ぎていれば最新分を同期する
  route = normalRoute;
  requests = [];
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await flush();
  assert.strictEqual(requests.length, 0, '直前に試行したので自動同期しない');
  await OrderDB.setMeta('lastSyncAttempt', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  w.document.dispatchEvent(new w.Event('visibilitychange')); // 連続しても 1 回だけ
  await flush();
  await waitSync();
  console.log('auto: requests', requests.length, '/', $('sync-status').textContent);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual($('sync-error').hidden, true);

  console.log('dashboard tests ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
