require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');
const express = require('express'); 
const path = require('path');        

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const IQAIR_KEY = process.env.IQAIR_KEY;
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY;

// 📌 แก้ไข Username ให้ตรงกับแชนแนลจริง
const TELEGRAM_CHANNEL = process.env.TELEGRAM_CHANNEL || '@weather_techno_chon'; 

// 📌 ตัวแปรจำสถานะการแจ้งเตือนล่าสุดเพื่อป้องกันการส่งข้อความซ้ำ
let lastAlertStates = {
    pm25: "Safe",    // Safe | Warning (37.6+) | Danger (75.1+)
    heat: "Safe",    // Safe | Warning (33°C+) | Danger (42°C+)
    rain: false      // true | false
};

// 📌 พิกัดสำหรับแต่ละเมือง (Chonburi, Pattaya, Si Racha)
const LOCATIONS = {
    main: { name: "อ.เมืองชลบุรี", lat: 13.3611, lon: 100.9847 },
    pattaya: { name: "เมืองพัทยา (Pattaya)", lat: 12.9236, lon: 100.8825 },
    siracha: { name: "อ.ศรีราชา (Si Racha)", lat: 13.1737, lon: 100.9311 }
};

function createEmptyLocationData() {
    return {
        aqi: 0, aqiLabel: "กำลังโหลด...", pm25: 0, temp: 0, humidity: 0,
        weatherDesc: "กำลังโหลด...", heatIndex: 0, heatWarning: "กำลังโหลด...",
        uvIndex: 0, uvLabel: "กำลังโหลด...", isRaining: false, updateTime: "-",
        forecast: [], history: []
    };
}

let storeData = {
    main: createEmptyLocationData(),
    pattaya: createEmptyLocationData(),
    siracha: createEmptyLocationData()
};

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/weather', (req, res) => {
    const loc = req.query.location || 'main';
    const targetData = storeData[loc] || storeData.main;

    const responseData = {
        ...targetData,
        comparison: {
            main: { aqi: storeData.main.aqi, pm25: storeData.main.pm25, label: storeData.main.aqiLabel },
            pattaya: { aqi: storeData.pattaya.aqi, pm25: storeData.pattaya.pm25, label: storeData.pattaya.aqiLabel },
            siracha: { aqi: storeData.siracha.aqi, pm25: storeData.siracha.pm25, label: storeData.siracha.aqiLabel }
        }
    };

    res.json(responseData);
});

app.get('/api/historical', (req, res) => {
    const loc = req.query.location || 'main';
    const targetData = storeData[loc] || storeData.main;
    res.json(targetData.history || []);
});

app.listen(PORT, () => {
    console.log(`🌐 [Web Server] แดชบอร์ดพร้อมทำงาน พอร์ต: ${PORT}`);
});

// 🚨 ฟังก์ชันส่งการแจ้งเตือนเข้า Telegram (มีระบบ Fallback ส่งข้อความธรรมดาถ้ารูปภาพมีปัญหา)
async function sendTelegramAlert(photoUrl, caption) {
    try {
        const photoApiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
        await axios.post(photoApiUrl, {
            chat_id: TELEGRAM_CHANNEL,
            photo: photoUrl,
            caption: caption,
            parse_mode: 'HTML'
        });
        console.log('🚨 [Telegram Alert] ส่งการ์ดแจ้งเตือนสำเร็จ!');
        return true;
    } catch (error) {
        console.warn('⚠️ [Telegram Photo Fail] ส่งรูปภาพไม่ผ่าน สลับเป็นข้อความตัวอักษร:', error.response?.data?.description || error.message);
        try {
            const messageApiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            await axios.post(messageApiUrl, {
                chat_id: TELEGRAM_CHANNEL,
                text: caption,
                parse_mode: 'HTML',
                disable_web_page_preview: false
            });
            console.log('🚨 [Telegram Alert] ส่งข้อความแจ้งเตือน (Fallback Text) สำเร็จ!');
            return true;
        } catch (msgErr) {
            console.error('❌ [Telegram Text Fail] ส่งข้อความไม่สำเร็จ:', msgErr.response?.data?.description || msgErr.message);
            return false;
        }
    }
}

// 🌡️ คำนวณ Heat Index
function calculateHeatIndex(temp, humidity) {
    if (temp < 27) return Math.round(temp);
    let F = temp * (9 / 5) + 32;
    let RH = humidity;
    let hiF = 0.5 * (F + 61.0 + ((F - 68.0) * 1.2) + (RH * 0.094));
    if (hiF >= 80) {
        let rothfusz = -42.379 + 2.04901523 * F + 10.14333127 * RH - 0.22475541 * F * RH 
                       - 0.00683783 * F * F - 0.05481717 * RH * RH + 0.00122874 * F * F * RH 
                       + 0.00085282 * F * RH * RH - 0.00000199 * F * F * RH * RH;
        hiF = (hiF + rothfusz) / 2;
    }
    let hiC = ((hiF - 32) * 5) / 9;
    let maxAllowed = temp + 8;
    if (hiC > maxAllowed) hiC = maxAllowed;
    return Math.round(hiC);
}

function getHeatIndexWarning(HI_C) {
    if (HI_C < 27.0) return { text: "ปกติ 🟢", color: "#27ae60" };
    if (HI_C <= 32.9) return { text: "เฝ้าระวัง 🟢", color: "#2ecc71" };
    if (HI_C <= 41.9) return { text: "เตือนภัย 🟡", color: "#f1c40f" };
    if (HI_C <= 51.9) return { text: "อันตราย 🟠", color: "#e67e22" };
    return { text: "อันตรายมาก 🔴", color: "#c0392b" };
}

// ☀️ คำนวณรังสี UV
function calculateSmartUVIndex(clouds = 0) {
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })).getHours();

    if (currentHour >= 18 || currentHour < 6) return { index: 0, label: "ต่ำ 🟢" };
    if (currentHour >= 6 && currentHour < 9) return { index: 1, label: "ต่ำ 🟢" };
    if (currentHour >= 9 && currentHour < 11) {
        const baseUV = Math.round(5 * (1 - clouds / 100));
        const uv = Math.max(2, baseUV);
        return { index: uv, label: uv <= 2 ? "ต่ำ 🟢" : "ปานกลาง 🟡" };
    }
    if (currentHour >= 11 && currentHour < 15) {
        const baseUV = Math.round(10 * (1 - clouds / 100));
        const uv = Math.max(4, baseUV);
        let label = "สูง 🟠";
        if (uv >= 11) label = "สุดขีด 🟣";
        else if (uv >= 8) label = "สูงมาก 🔴";
        else if (uv <= 5) label = "ปานกลาง 🟡";
        return { index: uv, label: label };
    }
    const baseUV = Math.round(4 * (1 - clouds / 100));
    const uv = Math.max(1, baseUV);
    return { index: uv, label: uv <= 2 ? "ต่ำ 🟢" : "ปานกลาง 🟡" };
}

// 🔄 ดึงข้อมูล Weather/AQI
async function fetchCityData(key) {
    const locConfig = LOCATIONS[key];
    try {
        let currentAQI = 0;
        let currentPM25 = 0;
        try {
            const iqRes = await axios.get(`https://api.airvisual.com/v2/nearest_city?lat=${locConfig.lat}&lon=${locConfig.lon}&key=${IQAIR_KEY}`);
            currentAQI = iqRes.data.data.current.pollution.aqius;
            
            if (iqRes.data.data.current.pollution.mainus === "p2") {
                if (currentAQI <= 50) currentPM25 = Math.round(currentAQI * 0.24);
                else if (currentAQI <= 100) currentPM25 = Math.round(12.1 + (currentAQI - 50) * 0.46);
                else currentPM25 = Math.round(35.5 + (currentAQI - 100) * 0.4);
            } else {
                currentPM25 = Math.round(currentAQI * 0.35); 
            }
        } catch (errIQ) {
            console.log(`⚠️ IQAir ${locConfig.name} ขัดข้อง (${errIQ.message}) - ใช้ค่าประมาณการสำรอง`);
            currentAQI = key === 'pattaya' ? 38 : key === 'siracha' ? 56 : 28;
            currentPM25 = key === 'pattaya' ? 13 : key === 'siracha' ? 20 : 7;
        }

        let aqiLabel = "";
        if (currentAQI <= 25) aqiLabel = "ดีมาก 🔵";
        else if (currentAQI <= 50) aqiLabel = "ดี 🟢";
        else if (currentAQI <= 100) aqiLabel = "ปานกลาง 🟡";
        else aqiLabel = "อันตรายต่อสุขภาพ 🔴";

        let temp = 30, humidity = 60, weatherDesc = "แจ่มใส", weatherId = 800, clouds = 0, rainVolume = 0;
        let dailyForecast = [];

        try {
            const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?lat=${locConfig.lat}&lon=${locConfig.lon}&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
            temp = weatherRes.data.main.temp;
            humidity = weatherRes.data.main.humidity;
            weatherDesc = weatherRes.data.weather[0].description;
            weatherId = weatherRes.data.weather[0].id;
            clouds = weatherRes.data.clouds ? weatherRes.data.clouds.all : 0;
            rainVolume = weatherRes.data.rain ? (weatherRes.data.rain['1h'] || weatherRes.data.rain['3h'] || 0) : 0;

            const forecastRes = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?lat=${locConfig.lat}&lon=${locConfig.lon}&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
            const checkedDates = new Set();
            const todayDateNum = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })).getDate();

            for (const item of forecastRes.data.list) {
                const itemDate = new Date(new Date(item.dt * 1000).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
                const itemDateNum = itemDate.getDate();

                if (itemDateNum !== todayDateNum && !checkedDates.has(itemDateNum)) {
                    dailyForecast.push({
                        day: itemDate.toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'Asia/Bangkok' }),
                        temp: Math.round(item.main.temp),
                        humidity: item.main.humidity,
                        desc: item.weather[0].description,
                        icon: item.weather[0].icon
                    });
                    checkedDates.add(itemDateNum);
                    if (dailyForecast.length >= 3) break;
                }
            }
        } catch (errOWM) {
            console.log(`⚠️ OpenWeather ${locConfig.name} ขัดข้อง (${errOWM.message})`);
        }

        const calculatedUV = calculateSmartUVIndex(clouds);
        const heatIndexC = calculateHeatIndex(temp, humidity);
        const heatWarning = getHeatIndexWarning(heatIndexC);
        
        // 🌧️ ตรวจจับสภาพฝนตกจาก Weather ID หรือปริมาณน้ำฝน
        const isRainingByCode = weatherId >= 200 && weatherId < 600;
        const hasRain = rainVolume >= 0.2 || isRainingByCode;

        const localTimeFormatted = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
        const timeLabel = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
        
        let history = storeData[key].history || [];
        if (history.length === 0 || history[history.length - 1].time !== timeLabel) {
            history.push({ time: timeLabel, aqi: currentAQI, temp: Math.round(temp) });
        }
        if (history.length > 12) history.shift();

        storeData[key] = {
            aqi: currentAQI, aqiLabel: aqiLabel, pm25: currentPM25, temp: temp, humidity: humidity,
            weatherDesc: weatherDesc, heatIndex: heatIndexC, heatWarning: heatWarning.text,
            uvIndex: calculatedUV.index, uvLabel: calculatedUV.label, isRaining: hasRain, updateTime: localTimeFormatted,
            forecast: dailyForecast, history: history
        };

    } catch (err) {
        console.error(`❌ ดึงข้อมูล ${locConfig.name} ขัดข้อง:`, err.message);
    }
}

// 📢 แจ้งเตือน 1 ครั้งเมื่ออัปเดตระบบ/เปิดเซิร์ฟเวอร์ใหม่
async function sendSystemStartupNotice() {
    const mainData = storeData.main;
    const chartConfig = {
        type: 'radialGauge',
        data: { datasets: [{ data: [mainData.aqi], backgroundColor: '#4f46e5', borderWidth: 0 }] },
        options: {
            title: { display: true, text: 'SYSTEM UPDATED & ONLINE', fontColor: '#38bdf8', fontSize: 16 },
            domain: [0, 200], trackColor: '#1e293b', centerPercentage: 75,
            centerArea: { text: `${mainData.aqi}`, fontColor: '#ffffff', fontSize: 54, subtext: `AQI Status`, subfontColor: '#94a3b8', subfontSize: 16 }
        }
    };
    const chartUrl = `https://quickchart.io/chart?bkg=%230f172a&w=700&h=420&devicePixelRatio=2&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

    let caption = `🚀 <b>[ TECHNO-CHON WEATHER UPDATED ]</b>\n`;
    caption += `✅ <i>ระบบได้รับการอัปเดตและพร้อมทำงานแล้ว (จะแจ้งเตือนเมื่อฝนตก หรือค่าดัชนีเกินเกณฑ์เท่านั้น)</i>\n\n`;
    caption += `📍 <b>สภาวะปัจจุบัน (อ.เมืองชลบุรี):</b>\n`;
    caption += `• สภาพอากาศ: ${mainData.weatherDesc} ${mainData.isRaining ? '🌧️ (ฝนตก)' : '☀️'}\n`;
    caption += `• อุณหภูมิ: <code>${mainData.temp}°C</code> (รู้สึกจริง <code>${mainData.heatIndex}°C</code>)\n`;
    caption += `• คุณภาพอากาศ: AQI <code>${mainData.aqi}</code> (${mainData.aqiLabel})\n`;
    caption += `• ฝุ่น PM2.5: <code>${mainData.pm25} µg/m³</code>\n`;
    caption += `• ความชื้น: <code>${mainData.humidity}%</code> | รังสี UV: <code>${mainData.uvIndex}</code>\n\n`;
    caption += `⏰ <i>เวลาอัปเดต: ${mainData.updateTime} น.</i>\n`;
    caption += `🌐 <a href="https://ctc-weather-report.onrender.com/">เข้าชมแดชบอร์ดสดแบบเต็ม</a>`;

    await sendTelegramAlert(chartUrl, caption);
}

// 🚨 ประมวลผลแจ้งเตือนเฉพาะเมื่อค่าเกินเกณฑ์มาตรฐาน หรือ มีฝนตก
async function checkAirAndWeatherAll() {
    await Promise.all([
        fetchCityData('main'),
        fetchCityData('pattaya'),
        fetchCityData('siracha')
    ]);

    const mainData = storeData.main;

    // 1. ประเมินระดับ PM2.5 / AQI
    let currentPM25State = "Safe";
    if (mainData.pm25 >= 75.1 || mainData.aqi > 200) currentPM25State = "Danger";
    else if (mainData.pm25 >= 37.6 || mainData.aqi > 100) currentPM25State = "Warning";

    // 2. ประเมินดัชนีความร้อน (Heat Index)
    let currentHeatState = "Safe";
    if (mainData.heatIndex >= 42) currentHeatState = "Danger";
    else if (mainData.heatIndex >= 33) currentHeatState = "Warning";

    // 3. ตรวจจับฝนตก
    const currentRainState = mainData.isRaining;

    // เช็กสภาวะเปลี่ยนเข้าขั้นแจ้งเตือน
    const hasPM25Alert = currentPM25State !== lastAlertStates.pm25 && currentPM25State !== "Safe";
    const hasHeatAlert = currentHeatState !== lastAlertStates.heat && currentHeatState !== "Safe";
    const hasRainAlert = currentRainState && !lastAlertStates.rain;

    let shouldUpdateState = true;

    // หากเข้าเงื่อนไขเตือนภัยข้อใดข้อหนึ่ง ให้ยิงแจ้งเตือนด่วน
    if (hasPM25Alert || hasHeatAlert || hasRainAlert) {
        let alertReasons = [];
        if (hasPM25Alert) alertReasons.push(`😷 <b>ฝุ่น PM2.5 / AQI เกินเกณฑ์มาตรฐาน (${mainData.pm25} µg/m³ / AQI ${mainData.aqi})!</b>`);
        if (hasHeatAlert) alertReasons.push(`🔥 <b>ดัชนีความร้อนอยู่ในระดับเสี่ยง (${mainData.heatIndex}°C)!</b>`);
        if (hasRainAlert) alertReasons.push(`🌧️ <b>ตรวจพบฝนตกในบริเวณสถานศึกษา (ระวังถนนลื่นและเตรียมร่ม)!</b>`);

        let themeColor = currentPM25State === "Danger" || currentHeatState === "Danger" ? "#ef4444" : "#f59e0b";

        const chartConfig = {
            type: 'radialGauge',
            data: { datasets: [{ data: [mainData.aqi], backgroundColor: themeColor, borderWidth: 0 }] },
            options: {
                title: { display: true, text: 'ALERT DETECTED', fontColor: '#ef4444', fontSize: 16 },
                domain: [0, 200], trackColor: '#1e293b', centerPercentage: 75,
                centerArea: { text: `${mainData.aqi}`, fontColor: '#ffffff', fontSize: 54, subtext: `AQI (${mainData.aqiLabel.split(' ')[0]})`, subfontColor: '#94a3b8', subfontSize: 16 }
            }
        };
        const chartUrl = `https://quickchart.io/chart?bkg=%230f172a&w=700&h=420&devicePixelRatio=2&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

        let textCaption = `🚨 <b>[ แจ้งเตือนสภาพอากาศด่วน! ]</b>\n📍 <i>สถานีหลัก: วิทยาลัยเทคโนโลยีชลบุรี</i>\n\n`;
        textCaption += `<blockquote>⚠️ <b>รายการเฝ้าระวัง:</b>\n` + alertReasons.map(r => `• ${r}`).join('\n') + `</blockquote>\n\n`;

        textCaption += `<blockquote>🍃 <b>ข้อมูลคุณภาพอากาศ & มลพิษ</b>\n`;
        textCaption += `• AQI: <code>${mainData.aqi}</code> (${mainData.aqiLabel})\n`;
        textCaption += `• PM2.5: <code>${mainData.pm25} µg/m³</code></blockquote>\n\n`;

        textCaption += `<blockquote>🌡️ <b>สภาพอากาศปัจจุบัน</b>\n`;
        textCaption += `• อุณหภูมิ: <code>${mainData.temp}°C</code> (รู้สึกจริง <code>${mainData.heatIndex}°C</code>)\n`;
        textCaption += `• ดัชนีความร้อน: ${mainData.heatWarning}\n`;
        textCaption += `• รังสี UV: <code>${mainData.uvIndex}</code> (${mainData.uvLabel}) | ความชื้น: <code>${mainData.humidity}%</code>\n`;
        textCaption += `• สภาพท้องฟ้า: ${mainData.weatherDesc}</blockquote>\n\n`;

        textCaption += `⏰ <i>ตรวจพบเมื่อ: ${mainData.updateTime} น.</i>\n`;
        textCaption += `🌐 <a href="https://ctc-weather-report.onrender.com/">เข้าชมแดชบอร์ดสดแบบเต็ม</a>`;

        const isSuccess = await sendTelegramAlert(chartUrl, textCaption);
        
        if (!isSuccess) {
            shouldUpdateState = false; 
            console.log("⚠️ [System] ระงับการบันทึกสถานะ เนื่องจากส่ง Telegram ไม่สำเร็จ");
        }
    }

    if (shouldUpdateState) {
        lastAlertStates = {
            pm25: currentPM25State,
            heat: currentHeatState,
            rain: currentRainState
        };
    }
}

// 🔄 เช็กสภาวะเตือนภัยทุกๆ 15 นาที
cron.schedule('*/15 * * * *', () => {
    console.log(`⏰ [Cron Job] ตรวจเช็กสภาวะเตือนภัย (ทุก 15 นาที)`);
    checkAirAndWeatherAll(); 
});

// 🚀 เริ่มต้นทำงานทันทีเมื่อเปิดเซิร์ฟเวอร์
(async () => {
    await checkAirAndWeatherAll();
    console.log('🚀 [Ready] ดึงข้อมูลรอบแรกเรียบร้อย กำลังส่งข้อความอัปเดตระบบ 1 ครั้ง...');
    await sendSystemStartupNotice();
})();
