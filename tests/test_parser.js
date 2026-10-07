// tests/test_parser.js
// parser.js を samples/ の HTML と単体テストで検証する（Node + jsdom）
// samples/ は個人情報を含むのでリポジトリに入れていない。手元にある場合だけ動く（末尾の単体テストは samples/ がなくても意味がある）
// 実行方法はリポジトリ直下の CLAUDE.md（amazon_order_tracker/ で PARSER_PATH=./parser.js node tests/test_parser.js）

const fs = require('fs');
const { JSDOM } = require('jsdom');
global.DOMParser = new JSDOM('').window.DOMParser;
const P = require(process.env.PARSER_PATH || './parser.js');
const fetchedAt = '2026-10-01T09:24:00+09:00';
const samples = fs.existsSync('samples') ? fs.readdirSync('samples').filter((f) => f.endsWith('.html')).sort() : [];
if (samples.length === 0) console.log('samples/ がないので実データの解析は省略する');
for (const f of samples) {
  const r = P.parseOrdersPage(fs.readFileSync('samples/' + f, 'utf8'), fetchedAt);
  console.log(`== ${f}: orders=${r.orders.length} errors=${JSON.stringify(r.errors)} encrypted=${r.encrypted} signedOut=${r.signedOut} years=${r.years[0]}..${r.years.at(-1)} next=${r.nextUrl && r.nextUrl.replace(/&ref_=.*/, '')}`);
  for (const o of r.orders) {
    console.log([o.orderDate, o.orderId, o.total, o.status, o.deliveredDate || '-', o.expectedDate || '-', `items=${o.items.length}`, `ship=${o.shipments.length}`, o.statusText, '|', o.items.map(i => i.asin + ':' + i.title.slice(0, 12) + (i.imageUrl ? '' : '(noimg)')).join(', ')].join(' '));
  }
}
// 単体テスト
const assert = require('assert');
assert.strictEqual(P.parseShipmentStatus('1月5日にお届け済み', '2026-12-28', '2027-01-06').date, '2027-01-05');
assert.strictEqual(P.parseShipmentStatus('金曜日にお届け', '2026-09-29', '2026-10-01').date, '2026-10-02');
assert.strictEqual(P.parseShipmentStatus('木曜日にお届け', '2026-10-06', '2026-10-08').date, '2026-10-08'); // 当日も曜日で表示される
assert.strictEqual(P.parseShipmentStatus('水曜日にお届け', '2026-10-06', '2026-10-08').date, '2026-10-14');
assert.strictEqual(P.parseShipmentStatus('明日お届け', '2026-09-29', '2026-10-01').date, '2026-10-02');
assert.strictEqual(P.parseShipmentStatus('キャンセル済み', '2026-08-31', '2026-10-01').status, 'cancelled');
assert.strictEqual(P.parseShipmentStatus('', '2020-01-10', '2026-10-08').status, 'closed'); // 古い注文は文言が空
assert.strictEqual(P.parseShipmentStatus('交換完了', '2020-01-10', '2026-10-08').status, 'closed');
assert.strictEqual(P.parseShipmentStatus('本日到着予定', '2026-10-06', '2026-10-08').date, '2026-10-08');
assert.strictEqual(P.summarizeShipments([{ status: 'closed', date: null }, { status: 'returned', date: null }]).status, 'returned');
assert.strictEqual(P.summarizeShipments([{ status: 'closed', date: null }, { status: 'closed', date: null }]).status, 'closed');
assert.strictEqual(P.parseYen('￥2,133'), 2133);
assert.strictEqual(P.summarizeShipments([{ status: 'delivered', date: '2026-09-30' }, { status: 'pending', date: '2026-10-02' }]).status, 'pending');
assert.strictEqual(P.summarizeShipments([{ status: 'delivered', date: '2026-09-30' }, { status: 'cancelled', date: null }]).status, 'delivered');
console.log('unit tests ok');
