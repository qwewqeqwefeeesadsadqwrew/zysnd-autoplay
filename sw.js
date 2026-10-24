// 演示站 Service Worker：首次加载后全量缓存，二次打开秒开
// ⚠ 不要用 cache.match(req, {ignoreSearch:true})：Chrome 对每一条缓存做线性扫描，
//    几千条缓存 × 几百个请求会把主线程拖死（实测页面卡死数分钟）。按「去掉 query 的完整 URL」精确匹配。
const CACHE = 'zysnd-autoplay-v1';
const ALWAYS_NETWORK = /(?:index\.html|game\.html|precache\.js|precache\.json|sw\.js|autoplay\.js)$/;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const key = e.request.url.split('#')[0].split('?')[0];
  if (ALWAYS_NETWORK.test(key)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});
