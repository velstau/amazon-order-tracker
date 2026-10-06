// db.js
// IndexedDB ラッパー。orders（注文、keyPath: orderId）と meta（最終同期日時など、keyPath: key）の 2 ストア

const OrderDB = (() => {
  const DB_NAME = 'amazon_order_tracker';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('orders')) {
          const store = db.createObjectStore('orders', { keyPath: 'orderId' });
          store.createIndex('orderDate', 'orderDate');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // ストアを開いて fn(store) を実行し、トランザクション完了で結果を返す
  async function withStore(name, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      let result;
      const req = fn(tx.objectStore(name));
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // orderId で上書き（upsert）する。配送中だった注文のステータスを更新するため
  function putOrders(orders) {
    return withStore('orders', 'readwrite', (store) => {
      for (const order of orders) store.put(order);
    });
  }

  function getAllOrders() {
    return withStore('orders', 'readonly', (store) => store.getAll());
  }

  async function getMeta(key) {
    const row = await withStore('meta', 'readonly', (store) => store.get(key));
    return row ? row.value : null;
  }

  function setMeta(key, value) {
    return withStore('meta', 'readwrite', (store) => store.put({ key, value }));
  }

  return { putOrders, getAllOrders, getMeta, setMeta };
})();
