// background.js (Service Worker)
// アイコンクリックでダッシュボードを開くだけ。HTML の解析はここでは行わない（DOMParser が使えないため）

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
