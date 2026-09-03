const CACHE_NAME = 'weather-techno-chon-v2'; // เปลี่ยนชื่อ Cache 
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

// --- เพิ่มส่วนนี้สำหรับการแจ้งเตือน (Push Notifications) ---
self.addEventListener('push', function(event) {
  // ตั้งค่าเริ่มต้น และเปลี่ยนชื่อเป็น Weather Techno Chon
  let payload = { title: 'Weather Techno Chon', body: 'มีการอัปเดตสภาพอากาศและ PM2.5' };

  // ถ้ารับข้อมูลเป็น JSON จากเซิร์ฟเวอร์
  if (event.data) {
    payload = event.data.json(); 
  }

  const options = {
    body: payload.body,
    icon: '/icon-192.png', // เปลี่ยนชื่อไฟล์ให้ตรงกับรูปโลโก้โปรเจกต์
    badge: '/icon-192.png'
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});
