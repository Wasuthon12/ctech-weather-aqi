const CACHE_NAME = 'ctc-weather-v2'; // อัปเดตเวอร์ชันเป็น v2
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

// Activate Service Worker (ลบ Cache เวอร์ชันเก่าทิ้งทันที)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('🧹 กำลังลบ Cache เก่า:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Assets (ใช้กลยุทธ์ Network-First: ดึงเว็บล่าสุดจากเซิร์ฟเวอร์ก่อน ถ้าออฟไลน์ค่อยใช้ Cache)
self.addEventListener('fetch', (event) => {
  // ข้ามการแคช API เพื่อให้ข้อมูลสภาพอากาศอัปเดตตลอดเวลา
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
