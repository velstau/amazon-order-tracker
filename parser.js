// parser.js
// 注文履歴ページの HTML → 注文オブジェクト。Amazon のページ構造が変わったら、まずここを直す
// 前提：disableCsd=no-js 付きで取得した平文版のページ（通常版はカードの中身が暗号化されている）
// DOMParser を使うので、Service Worker ではなく拡張ページで呼ぶこと

const AmazonParser = (() => {
  const ORIGIN = 'https://www.amazon.co.jp';

  // セレクタはここに集約する（2026-10-01 の実ページで確認）
  const SELECTORS = {
    orderCard: '.order-card',
    encrypted: '.csd-encrypted-sensitive',
    signInForm: 'form[name="signIn"]',
    headerItem: '.order-header__header-list-item',
    headerLabel: '.a-text-caps',
    orderIdText: '.yohtmlc-order-id span:last-child',
    detailLink: 'a[href*="order-details"]',
    shipment: '.delivery-box',
    shipmentPrimary: '.delivery-box__primary-text',
    shipmentSecondary: '.yohtmlc-shipment-status-secondaryText',
    productLink: 'a[href*="/dp/"], a[href*="/gp/product/"]',
    productTitle: '.yohtmlc-product-title',
    nextPage: '.a-pagination li.a-last:not(.a-disabled) a[href]',
    yearOption: 'select#time-filter option[value^="year-"]',
  };

  // ヘッダの見出し文言。サブスクリプションの課金（注文番号 D01-）は注文日の代わりに課金日が出る
  const LABELS = { orderDate: ['注文日', 'サブスクリプション課金日'], total: '合計' };

  // カードの data-csa-c-slot-id は "amzn1.yourorders.order-card.<注文番号>"
  const SLOT_ID_RE = /order-card\.([0-9A-Z-]+)$/;
  const ASIN_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const pad = (n) => String(n).padStart(2, '0');
  const toIsoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const absolute = (href) => (href ? new URL(href, ORIGIN).href : null);

  // "2026年9月30日" → "2026-09-30"
  function parseJpDate(text) {
    const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text || '');
    return m ? toIsoDate(m[1], m[2], m[3]) : null;
  }

  // "￥2,133" → 2133
  function parseYen(text) {
    const m = /[￥¥]\s*([\d,]+)/.exec(text || '');
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  // 年なしの "9月30日" を、基準日（注文日）以降の日付として補完する
  function completeMonthDay(month, day, baseIsoDate) {
    const [baseYear, baseMonth] = baseIsoDate.split('-').map(Number);
    const year = month < baseMonth ? baseYear + 1 : baseYear;
    return toIsoDate(year, month, day);
  }

  function addDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00`);
    d.setDate(d.getDate() + days);
    return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  // 配送ボックスの表示文言 → { status, date }
  // status: delivered / pending（未配達。準備中と配送中は一覧ページでは区別できない）/ cancelled / returned
  //         / closed（配達状況が表示されない古い注文と、交換などの手続きが済んだもの）/ unknown
  // date: delivered なら配達日、pending なら配達予定日
  function parseShipmentStatus(text, orderDate, fetchedDate) {
    // 注文から数か月以上たった古い注文は文言が空になる。キャンセルは古くても「キャンセル済み」と出る
    if (!text) return { status: 'closed', date: null };
    if (/キャンセル/.test(text)) return { status: 'cancelled', date: null };
    if (/返品|返金/.test(text)) return { status: 'returned', date: null };
    if (/交換|サービスを完了/.test(text)) return { status: 'closed', date: null };

    const delivered = /お届け済み|配達済み/.test(text);
    const md = /(\d{1,2})月(\d{1,2})日/.exec(text);
    if (md && orderDate) {
      const date = completeMonthDay(Number(md[1]), Number(md[2]), orderDate);
      return { status: delivered ? 'delivered' : 'pending', date };
    }
    if (delivered) return { status: 'delivered', date: null };

    // 以下は配達予定。日付は取得日を基準に求める
    if (/今日|本日/.test(text)) return { status: 'pending', date: fetchedDate };
    if (/明日/.test(text)) return { status: 'pending', date: addDays(fetchedDate, 1) };
    const wd = /([日月火水木金土])曜日/.exec(text);
    if (wd) {
      // 「金曜日にお届け」は今日から 6 日後までの、直近のその曜日とみなす
      // 当日のお届けも「今日」でなく曜日で表示されるので、今日と同じ曜日なら今日
      const today = new Date(`${fetchedDate}T00:00:00`).getDay();
      const offset = (WEEKDAYS.indexOf(wd[1]) - today + 7) % 7;
      return { status: 'pending', date: addDays(fetchedDate, offset) };
    }
    if (/お届け|発送|出荷|配送/.test(text)) return { status: 'pending', date: null };
    return { status: 'unknown', date: null };
  }

  // 発送ごとのステータスから、注文単位の代表ステータスを決める
  function summarizeShipments(shipments) {
    const active = shipments.filter((s) => s.status !== 'cancelled');
    if (shipments.length > 0 && active.length === 0) return { status: 'cancelled', deliveredDate: null, expectedDate: null };

    const latest = (list) => list.map((s) => s.date).filter(Boolean).sort().pop() || null;
    const pending = active.filter((s) => s.status === 'pending');
    if (pending.length > 0) return { status: 'pending', deliveredDate: null, expectedDate: latest(pending) };
    if (active.some((s) => s.status === 'unknown') || active.length === 0) return { status: 'unknown', deliveredDate: null, expectedDate: null };
    if (active.some((s) => s.status === 'returned')) return { status: 'returned', deliveredDate: latest(active), expectedDate: null };
    if (active.some((s) => s.status === 'delivered')) return { status: 'delivered', deliveredDate: latest(active), expectedDate: null };
    return { status: 'closed', deliveredDate: null, expectedDate: null };
  }

  // 商品は /dp/<ASIN> へのリンクを ASIN ごとにまとめて取る
  // （3 点以上の注文はカルーセル表示になり、.yohtmlc-product-title が付かないため）
  function parseItems(root) {
    const items = new Map();
    for (const a of root.querySelectorAll(SELECTORS.productLink)) {
      const m = ASIN_RE.exec(a.getAttribute('href'));
      if (!m) continue;
      const asin = m[1];
      const item = items.get(asin) || { title: '', asin, url: `${ORIGIN}/dp/${asin}`, imageUrl: null };
      const img = a.querySelector('img');
      if (img) {
        item.imageUrl = item.imageUrl || img.getAttribute('src');
        item.title = item.title || clean(img.getAttribute('alt'));
      }
      const text = clean(a.textContent);
      if (text.length > item.title.length) item.title = text;
      items.set(asin, item);
    }
    // デジタル注文（アプリなど）は商品ページへのリンクがなく、商品名だけ出る
    for (const el of root.querySelectorAll(SELECTORS.productTitle)) {
      const title = clean(el.textContent);
      if (!title || el.querySelector(SELECTORS.productLink)) continue;
      if (!items.has(title)) items.set(title, { title, asin: null, url: null, imageUrl: null });
    }
    return [...items.values()];
  }

  function parseHeader(card) {
    const values = {};
    for (const li of card.querySelectorAll(SELECTORS.headerItem)) {
      const label = clean(li.querySelector(SELECTORS.headerLabel)?.textContent);
      const rows = li.querySelectorAll('.a-row');
      if (label && rows.length > 0) values[label] = clean(rows[rows.length - 1].textContent);
    }
    return values;
  }

  function parseOrderCard(card, fetchedAt) {
    const slotId = card.getAttribute('data-csa-c-slot-id') || '';
    const orderId = SLOT_ID_RE.exec(slotId)?.[1] || clean(card.querySelector(SELECTORS.orderIdText)?.textContent);
    if (!orderId) throw new Error('注文番号が見つからない');

    const header = parseHeader(card);
    const orderDate = parseJpDate(header[LABELS.orderDate.find((label) => header[label])]);
    if (!orderDate) throw new Error(`注文日を解析できない（${orderId}）`);

    const fetchedDate = fetchedAt.slice(0, 10);
    const shipments = [...card.querySelectorAll(SELECTORS.shipment)].map((box) => {
      const primary = clean(box.querySelector(SELECTORS.shipmentPrimary)?.textContent);
      const secondary = clean(box.querySelector(SELECTORS.shipmentSecondary)?.textContent);
      return { statusText: primary, detailText: secondary, ...parseShipmentStatus(primary, orderDate, fetchedDate), items: parseItems(box) };
    });

    const summary = summarizeShipments(shipments);
    return {
      orderId,
      orderDate,
      total: parseYen(header[LABELS.total]), // キャンセル済みの注文では表示されず null になる
      status: summary.status,
      statusText: shipments.map((s) => s.statusText).filter(Boolean).join(' / '),
      deliveredDate: summary.deliveredDate,
      expectedDate: summary.expectedDate,
      items: parseItems(card),
      shipments,
      detailUrl: absolute(card.querySelector(SELECTORS.detailLink)?.getAttribute('href')),
      fetchedAt,
    };
  }

  // 1 ページ分を解析する。カード単位の失敗は errors に積み、ページ全体は止めない
  // 戻り値：{ orders, errors, nextUrl, years, signedOut, encrypted }
  function parseOrdersPage(html, fetchedAt) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = {
      orders: [],
      errors: [],
      nextUrl: absolute(doc.querySelector(SELECTORS.nextPage)?.getAttribute('href')),
      years: [...doc.querySelectorAll(SELECTORS.yearOption)].map((o) => Number(o.value.replace('year-', ''))),
      signedOut: !!doc.querySelector(SELECTORS.signInForm),
      encrypted: !!doc.querySelector(`${SELECTORS.orderCard} ${SELECTORS.encrypted}`),
    };
    if (result.signedOut || result.encrypted) return result;

    for (const card of doc.querySelectorAll(SELECTORS.orderCard)) {
      try {
        result.orders.push(parseOrderCard(card, fetchedAt));
      } catch (e) {
        result.errors.push(e.message);
      }
    }
    return result;
  }

  return { SELECTORS, parseOrdersPage, parseJpDate, parseYen, parseShipmentStatus, summarizeShipments };
})();

// Node での検証用（ブラウザでは module が未定義なので何もしない）
if (typeof module !== 'undefined') module.exports = AmazonParser;
