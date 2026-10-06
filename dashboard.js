// dashboard.js
// ダッシュボードの表示と同期ボタンの制御
// 支出額の定義（引継書 5 章）：注文合計（total）を、注文日の月に計上する。キャンセル済みは除く

// 開いたとき・タブに戻ったときに、前回の同期の試行からこれ以上たっていれば最新分を自動で同期する
const AUTO_SYNC_INTERVAL_MS = 60 * 60 * 1000;

const state = {
  orders: [],
  filter: { month: '', keyword: '', pendingOnly: false },
  abortController: null,
  autoSyncChecking: false,
};

const $ = (id) => document.getElementById(id);

// 要素を作る小さなヘルパー。文字列は textContent で入れる（HTML として解釈しない）
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) el.append(child);
  }
  return el;
}

const yen = (n) => `￥${(n || 0).toLocaleString('ja-JP')}`;
const monthKey = (isoDate) => isoDate.slice(0, 7); // "2026-09"
const monthLabel = (key) => `${Number(key.slice(0, 4))}年${Number(key.slice(5, 7))}月`;
const shortDate = (isoDate) => (isoDate ? `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}` : '');
const isSpending = (order) => order.status !== 'cancelled';

// 棒の上に出す値は幅に収まるよう短くする（例：12,345 → 1.2万）
function compactYen(n) {
  return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : `￥${n.toLocaleString('ja-JP')}`;
}

function todayMonthKey(offsetMonths = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function summarizeByMonth(orders) {
  const byMonth = new Map();
  for (const order of orders) {
    if (!isSpending(order)) continue;
    const key = monthKey(order.orderDate);
    const row = byMonth.get(key) || { total: 0, count: 0 };
    row.total += order.total || 0;
    row.count += 1;
    byMonth.set(key, row);
  }
  return byMonth;
}

// ---- 支出の概要 ----

function renderKpis(byMonth) {
  const thisMonth = byMonth.get(todayMonthKey()) || { total: 0, count: 0 };
  const lastMonth = byMonth.get(todayMonthKey(-1)) || { total: 0, count: 0 };
  $('kpi-this-month').textContent = yen(thisMonth.total);
  $('kpi-this-month-sub').textContent = `${monthLabel(todayMonthKey())}・${thisMonth.count} 件`;
  $('kpi-last-month').textContent = yen(lastMonth.total);
  $('kpi-last-month-sub').textContent = `${monthLabel(todayMonthKey(-1))}・${lastMonth.count} 件`;
}

// ---- 月別の棒グラフ ----

// 目盛りをきりのよい刻み（1・2・2.5・5 × 10^n）で、5 本以内に収める
function niceTicks(value) {
  const max = Math.max(value, 1000);
  const exp = 10 ** Math.floor(Math.log10(max / 5));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * exp).find((st) => Math.ceil(max / st) <= 5);
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

function renderChart(byMonth) {
  const months = Array.from({ length: 12 }, (_, i) => todayMonthKey(i - 11));
  const rows = months.map((key) => ({ key, ...(byMonth.get(key) || { total: 0, count: 0 }) }));
  const ticks = niceTicks(Math.max(...rows.map((r) => r.total)));
  const max = ticks[ticks.length - 1];
  const maxRow = rows.reduce((a, b) => (b.total > a.total ? b : a), rows[0]);

  const plot = $('chart-plot');
  const yAxis = $('chart-y');
  const xAxis = $('chart-x');
  plot.replaceChildren();
  yAxis.replaceChildren();
  xAxis.replaceChildren();
  plot.classList.toggle('has-selection', !!state.filter.month);

  for (const tick of ticks) {
    const bottom = `${(tick / max) * 100}%`;
    yAxis.append(h('span', { style: `bottom:${bottom}; transform:translateY(50%)`, text: tick.toLocaleString('ja-JP') }));
    if (tick > 0) plot.append(h('div', { class: 'chart__grid', style: `bottom:${bottom}` }));
  }

  for (const row of rows) {
    const selected = state.filter.month === row.key;
    // 値のラベルは選択中の月・今月・最大の月だけに付ける（全部に付けると読めない）
    const showLabel = row.total > 0 && (selected || row.key === todayMonthKey() || row === maxRow);
    const slot = h('button', {
      type: 'button',
      class: 'chart__slot',
      'aria-pressed': selected ? 'true' : 'false',
      'aria-label': `${monthLabel(row.key)} ${yen(row.total)}、${row.count} 件`,
    },
    showLabel ? h('span', { class: 'chart__label', text: compactYen(row.total) }) : null,
    h('div', { class: 'chart__bar', style: `height:${(row.total / max) * 100}%` }));

    const tip = `${monthLabel(row.key)}　${yen(row.total)}（${row.count} 件）`;
    slot.addEventListener('mouseenter', () => showTooltip(slot, tip));
    slot.addEventListener('focus', () => showTooltip(slot, tip));
    slot.addEventListener('mouseleave', hideTooltip);
    slot.addEventListener('blur', hideTooltip);
    slot.addEventListener('click', () => {
      state.filter.month = selected ? '' : row.key;
      render();
      if (!selected) $('orders-heading').scrollIntoView({ behavior: 'smooth' });
    });
    plot.append(slot);

    // 1 月と左端は 2 行目に年も出す（1 行にすると列の幅を超える）
    const m = Number(row.key.slice(5, 7));
    const showYear = m === 1 || row === rows[0];
    xAxis.append(h('span', {}, `${m}月`, showYear ? h('br') : null, showYear ? `${row.key.slice(0, 4)}` : null));
  }

  $('monthly-table').replaceChildren(...[...rows].reverse().map((row) => h('tr', {},
    h('td', { text: monthLabel(row.key) }),
    h('td', { class: 'num', text: yen(row.total) }),
    h('td', { class: 'num', text: `${row.count} 件` }))));
}

function showTooltip(slot, text) {
  const tooltip = $('chart-tooltip');
  const chart = $('monthly-chart');
  tooltip.textContent = text;
  tooltip.hidden = false;
  // 棒の先端のすぐ上に出す
  const chartRect = chart.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  const barTop = slot.querySelector('.chart__bar').getBoundingClientRect().top - chartRect.top;
  const left = slotRect.left - chartRect.left + slotRect.width / 2 - tooltip.offsetWidth / 2;
  tooltip.style.left = `${Math.max(0, Math.min(left, chartRect.width - tooltip.offsetWidth))}px`;
  tooltip.style.top = `${Math.max(-tooltip.offsetHeight, barTop - tooltip.offsetHeight - 8)}px`;
}

function hideTooltip() {
  $('chart-tooltip').hidden = true;
}

// ---- 注文の表示部品 ----

const STATUS_TEXT = {
  delivered: '配達済み',
  pending: '未配達',
  cancelled: 'キャンセル',
  returned: '返品',
  unknown: '不明',
};

function statusCell(order) {
  let text = STATUS_TEXT[order.status] || order.status;
  if (order.status === 'delivered' && order.deliveredDate) text = `配達済み ${shortDate(order.deliveredDate)}`;
  if (order.status === 'pending') text = order.expectedDate ? `${shortDate(order.expectedDate)} 配達予定` : '未配達';
  // 分割発送や不明な表示は、Amazon の原文も添える
  const showRaw = order.status === 'unknown' || order.shipments?.length > 1;
  return h('span', { class: `status status--${order.status}` },
    text,
    showRaw && order.statusText ? h('span', { class: 'status__detail', text: order.statusText }) : null);
}

function itemsCell(order, limit = 3) {
  const shown = order.items.slice(0, limit);
  return h('div', { class: 'items' },
    shown.map((item) => h('div', { class: 'item' },
      item.imageUrl ? h('img', { src: item.imageUrl, alt: '', loading: 'lazy' }) : null,
      h('a', { href: item.url, target: '_blank', rel: 'noopener', text: item.title || item.asin }))),
    order.items.length > limit ? h('span', { class: 'more', text: `ほか ${order.items.length - limit} 点` }) : null);
}

function amountCell(order) {
  if (order.total === null || order.total === undefined) return h('span', { class: 'more', text: '—' });
  return h('span', { class: isSpending(order) ? null : 'cancelled-amount', text: yen(order.total) });
}

// ---- 未配達の注文 ----

function renderPending(orders) {
  const pending = orders
    .filter((o) => o.status === 'pending')
    .sort((a, b) => (a.expectedDate || '9999').localeCompare(b.expectedDate || '9999'));
  const container = $('pending-list');
  if (pending.length === 0) {
    container.replaceChildren(h('p', { class: 'empty', text: '未配達の注文はありません。' }));
    return;
  }
  container.replaceChildren(...pending.map((order) => h('div', { class: 'pending-item' },
    h('div', { class: 'pending-item__date', text: order.expectedDate ? `${shortDate(order.expectedDate)} 配達予定` : '予定日不明' }),
    h('div', {}, itemsCell(order, 2), h('span', { class: 'more', text: `${shortDate(order.orderDate)} 注文・${yen(order.total)}` })))));
}

// ---- 注文一覧 ----

function renderMonthOptions(orders) {
  const select = $('filter-month');
  const months = [...new Set(orders.map((o) => monthKey(o.orderDate)))].sort().reverse();
  if (state.filter.month && !months.includes(state.filter.month)) months.unshift(state.filter.month);
  select.replaceChildren(
    h('option', { value: '', text: 'すべて' }),
    ...months.map((key) => h('option', { value: key, text: monthLabel(key) })));
  select.value = state.filter.month;
}

function filteredOrders(orders) {
  const keyword = state.filter.keyword.trim().toLowerCase();
  return orders.filter((o) => {
    if (state.filter.month && monthKey(o.orderDate) !== state.filter.month) return false;
    if (state.filter.pendingOnly && o.status !== 'pending') return false;
    if (keyword) {
      const haystack = [o.orderId, ...o.items.map((i) => i.title)].join(' ').toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

function renderOrders(orders) {
  const list = filteredOrders(orders);
  const spending = list.filter(isSpending).reduce((sum, o) => sum + (o.total || 0), 0);
  $('orders-summary').textContent = `${list.length} 件・支出 ${yen(spending)}（キャンセルを除く）`;

  const body = $('orders-body');
  if (list.length === 0) {
    const message = orders.length === 0 ? 'まだ注文データがありません。初回は「全期間を同期」を押してください。' : '条件に合う注文はありません。';
    body.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'empty', text: message })));
    return;
  }
  body.replaceChildren(...list.map((order) => h('tr', {},
    h('td', { text: order.orderDate.replaceAll('-', '/') }),
    h('td', {}, itemsCell(order)),
    h('td', { class: 'num' }, amountCell(order)),
    h('td', {}, statusCell(order)),
    h('td', {}, order.detailUrl ? h('a', { href: order.detailUrl, target: '_blank', rel: 'noopener', text: '注文詳細' }) : null))));
}

// ---- 全体 ----

function render() {
  const byMonth = summarizeByMonth(state.orders);
  renderKpis(byMonth);
  renderChart(byMonth);
  renderPending(state.orders);
  renderMonthOptions(state.orders);
  renderOrders(state.orders);
}

async function reload() {
  state.orders = (await OrderDB.getAllOrders()).sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.orderId.localeCompare(a.orderId));
  render();
}

function formatDateTime(iso) {
  return iso ? iso.slice(0, 16).replace('T', ' ').replaceAll('-', '/') : '';
}

async function showLastSync() {
  const last = await OrderDB.getMeta('lastSync');
  $('sync-status').textContent = last
    ? `最終同期：${formatDateTime(last.at)}（${last.mode === 'full' ? '全期間' : '最新分'}・${last.pages} ページ）`
      + (last.errors?.length ? `　解析できなかった注文 ${last.errors.length} 件` : '')
    : 'まだ同期していません。';
}

function setSyncing(syncing) {
  $('sync-recent').disabled = syncing;
  $('sync-full').disabled = syncing;
  $('sync-abort').hidden = !syncing;
}

async function startSync(mode) {
  $('sync-error').hidden = true;
  setSyncing(true);
  state.abortController = new AbortController();
  try {
    // 自動同期の間隔は、成功ではなく試行の時刻で数える（失敗時に開くたび再試行しないため）
    await OrderDB.setMeta('lastSyncAttempt', new Date().toISOString());
    const summary = await OrderSync.run({
      mode,
      signal: state.abortController.signal,
      onProgress: ({ message, saved }) => {
        $('sync-status').textContent = `${message}（取得済み ${saved} 件）`;
        reload(); // 取得したページから順に画面へ反映する
      },
    });
    await reload();
    await showLastSync();
    if (summary.errors.length) console.warn('解析できなかった注文', summary.errors);
  } catch (e) {
    await reload();
    if (e.name === 'AbortError') {
      $('sync-status').textContent = '同期を中止しました。それまでに取得した分は保存されています。';
    } else {
      $('sync-error').textContent = e instanceof OrderSync.SyncError ? e.message : `同期に失敗しました：${e.message}`;
      $('sync-error').hidden = false;
      console.error(e);
    }
  } finally {
    state.abortController = null;
    setSyncing(false);
  }
}

$('sync-recent').addEventListener('click', () => startSync('recent'));
$('sync-full').addEventListener('click', () => {
  if (confirm('全期間の注文履歴を取得します。1 ページごとに 1.5〜2 秒待つため、注文が多いと数分かかります。続けますか？')) startSync('full');
});
$('sync-abort').addEventListener('click', () => state.abortController?.abort());

$('filter-month').addEventListener('change', (e) => { state.filter.month = e.target.value; render(); });
$('filter-keyword').addEventListener('input', (e) => { state.filter.keyword = e.target.value; renderOrders(state.orders); });
$('filter-pending').addEventListener('change', (e) => { state.filter.pendingOnly = e.target.checked; renderOrders(state.orders); });

async function autoSyncIfStale() {
  if (state.abortController || state.autoSyncChecking) return;
  // 初回（データなし）は時間のかかる全期間同期が必要なので、自動では始めない
  if (state.orders.length === 0) return;
  state.autoSyncChecking = true;
  try {
    const lastAttempt = await OrderDB.getMeta('lastSyncAttempt');
    if (lastAttempt && Date.now() - Date.parse(lastAttempt) < AUTO_SYNC_INTERVAL_MS) return;
    if (state.abortController) return; // 確認中に手動同期が始まった
    startSync('recent');
  } finally {
    state.autoSyncChecking = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') autoSyncIfStale();
});

(async () => {
  await reload();
  await showLastSync();
  await autoSyncIfStale();
})();
