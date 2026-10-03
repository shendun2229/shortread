/* ShortRead Service Worker
 * 策略：静态资源预缓存（stale-while-revalidate 更新），
 *       文章数据接口始终联网、不做缓存。
 */
var CACHE_NAME = 'shortread-static-v2';
var STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './mock.js',
  './manifest.json',
  './icons/icon-192.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(STATIC_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key !== CACHE_NAME) return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);

  // 跨域请求（每日简讯接口、封面图等）：直接联网，不经过缓存
  if (url.origin !== self.location.origin) return;

  // 静态资源：缓存优先，同时联网回源更新缓存
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || networkFetch;
    })
  );
});
