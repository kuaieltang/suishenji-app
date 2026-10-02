/**
 * Service Worker：缓存应用外壳，使得断网也能打开记录。
 *
 * 明确不缓存任何跨域请求——远端托管（GitHub / Gitee / GitCode）的 API 响应必须实时，绝不进缓存。
 */

// 版本号变了才会清掉旧缓存；改动前端文件时顺手加一。
const CACHE = 'suishenji-v14';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './fonts/misans/misans-regular.css',
  './fonts/lxgw/lxgw-bright.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/core.js',
  './src/store.js',
  './src/github.js',
  './src/gitee.js',
  './src/remote.js',
  './src/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 远端托管 API 等跨域请求一律直连

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
