// sync.js
// 注文履歴の取得制御：年一覧・ページ送り・待機・保存
// parser.js（DOMParser を使う）に依存するので、拡張ページで動かす

const OrderSync = (() => {
  const ORIGIN = 'https://www.amazon.co.jp';
  const WAIT_MS = 1500;          // ページ取得の間隔（Amazon に負荷をかけない）
  const WAIT_JITTER_MS = 500;
  const MAX_PAGES_PER_YEAR = 100; // ページ送りが止まらない場合の安全弁
  const FINAL_STATUSES = new Set(['delivered', 'cancelled', 'returned', 'closed']);
  const RECHECK_DAYS = 90;        // 最新分の同期で、確定していない注文を読み直す期間

  class SyncError extends Error {}

  // disableCsd=no-js を付けないとカードの中身が暗号化される
  const yearUrl = (year) => `${ORIGIN}/your-orders/orders?disableCsd=no-js&timeFilter=year-${year}&startIndex=0`;

  function ensureNoJs(url) {
    const u = new URL(url);
    u.searchParams.set('disableCsd', 'no-js');
    return u.href;
  }

  // "2026-10-01T09:24:00+09:00" 形式（日付をローカル時刻で扱うため）
  function localIsoString(date = new Date()) {
    const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('中止しました', 'AbortError'));
      }, { once: true });
    });
  }

  async function fetchPage(url, signal) {
    const res = await fetch(url, { credentials: 'include', signal });
    const html = await res.text();
    if (res.url.includes('/ap/signin')) throw new SyncError('Amazon にログインしていません。amazon.co.jp にログインしてから、もう一度同期してください。');
    if (res.url.includes('validateCaptcha') || html.includes('validateCaptcha')) throw new SyncError('Amazon に CAPTCHA を求められました。しばらく時間をおいてから同期してください。');
    if (!res.ok) throw new SyncError(`注文履歴ページの取得に失敗しました（HTTP ${res.status}）。`);

    const page = AmazonParser.parseOrdersPage(html, localIsoString());
    if (page.signedOut) throw new SyncError('Amazon にログインしていません。amazon.co.jp にログインしてから、もう一度同期してください。');
    if (page.encrypted) throw new SyncError('注文の中身が暗号化されたページが返されました。Amazon の仕様が変わった可能性があります（parser.js の確認が必要）。');
    return page;
  }

  // 最新分の同期で読み直す注文：確定していない（未配達・不明）注文のうち、注文日か配達予定日が since 以降のもの
  // 古い「不明」の注文まで読み直すと、そこまでの全ページを毎回読むことになる
  function needsRecheck(order, since) {
    if (FINAL_STATUSES.has(order.status)) return false;
    return order.orderDate >= since || (!!order.expectedDate && order.expectedDate >= since);
  }

  // 最新分の同期で、このページより古いページを読む必要があるか
  // DB と同じ内容で、読み直す対象でもない注文だけなら、そのページで止めてよい
  function isSettled(orders, known, recheckIds) {
    return orders.length > 0 && orders.every((o) => {
      const prev = known.get(o.orderId);
      return prev && !recheckIds.has(o.orderId) && prev.status === o.status && prev.total === o.total;
    });
  }

  // mode: 'recent'（最新分）または 'full'（全期間）
  // onProgress({ year, page, saved, message }) で進み具合を通知する
  async function run({ mode, onProgress = () => {}, signal }) {
    const known = new Map((await OrderDB.getAllOrders()).map((o) => [o.orderId, o]));
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - RECHECK_DAYS);
    const since = localIsoString(sinceDate).slice(0, 10);
    const recheck = [...known.values()].filter((o) => needsRecheck(o, since));
    const recheckIds = new Set(recheck.map((o) => o.orderId));
    // 年ごとの、読み直す注文の最も古い注文日（その年はそこまで読み進める）
    const oldestRecheck = new Map();
    for (const o of recheck) {
      const y = Number(o.orderDate.slice(0, 4));
      if (!oldestRecheck.has(y) || o.orderDate < oldestRecheck.get(y)) oldestRecheck.set(y, o.orderDate);
    }

    const currentYear = new Date().getFullYear();
    const summary = { pages: 0, saved: 0, errors: [] };
    let years = [currentYear];
    let requestCount = 0;

    for (let yi = 0; yi < years.length; yi++) {
      const year = years[yi];
      let url = yearUrl(year);

      for (let pageNo = 1; url && pageNo <= MAX_PAGES_PER_YEAR; pageNo++) {
        if (requestCount > 0) await sleep(WAIT_MS + Math.random() * WAIT_JITTER_MS, signal);
        onProgress({ year, page: pageNo, saved: summary.saved, message: `${year} 年の ${pageNo} ページ目を取得中…` });

        const page = await fetchPage(url, signal);
        requestCount++;
        summary.pages++;

        // 1 ページ目で年の一覧が分かる。全期間なら全年
        // 最新分なら、読み直す注文がある年と、読み直す期間に入る年（年明けに前年末の注文を拾うため）
        if (yi === 0 && pageNo === 1) {
          const listed = page.years.filter((y) => y < currentYear);
          if (mode === 'full') years = [currentYear, ...listed];
          else years = [currentYear, ...listed.filter((y) => oldestRecheck.has(y) || y >= Number(since.slice(0, 4)))];
        }

        if (page.orders.length > 0) await OrderDB.putOrders(page.orders);
        summary.saved += page.orders.length;
        summary.errors.push(...page.errors);

        // 読み直す注文より古いページまで来たら、この年は終わり（次の年は years にあれば読む）
        if (mode === 'recent' && isSettled(page.orders, known, recheckIds)) {
          const pageOldest = page.orders.map((o) => o.orderDate).sort()[0];
          const until = oldestRecheck.get(year);
          if (!until || pageOldest < until) break;
        }
        for (const o of page.orders) known.set(o.orderId, o);
        url = page.nextUrl ? ensureNoJs(page.nextUrl) : null;
      }
    }

    await OrderDB.setMeta('lastSync', { at: localIsoString(), mode, ...summary });
    return summary;
  }

  return { run, SyncError, localIsoString };
})();
