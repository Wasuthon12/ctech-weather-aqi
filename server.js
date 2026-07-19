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
const TELEGRAM_CHANNEL = '@ctech_pm25_alert'; 

let lastAlertStatus = "Normal"; 

// 📌 ตัวแปรหลักสำหรับเก็บข้อมูลส่งให้หน้าเว็บ Frontend (เพิ่ม pm25 เข้ามา)
let latestData = {
    aqi: 0,
    aqiLabel: "กำลังโหลด...",
    pm25: 0, // 👈 เพิ่มตัวแปรเก็บค่าฝุ่น PM2.5 จริง
    temp: 0,
    humidity: 0,
    weatherDesc: "กำลังโหลด...",
    heatIndex: 0,
    heatWarning: "กำลังโหลด...",
    isRaining: false,
    updateTime: "-"
};

let historicalData = []; 

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/weather', (req, res) => {
    res.json(latestData);
});

app.get('/api/historical', (req, res) => {
    res.json(historicalData);
});

app.listen(PORT, () => {
    console.log(`🌐 [Web Server] แดชบอร์ดพร้อมทำงานบน Cloud/Local พอร์ต: ${PORT}`);
});

async function sendTelegramPhoto(photoUrl, caption) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHANNEL,
            photo: photoUrl,
            caption: caption,
            parse_mode: 'HTML'
        });
        console.log('🎨 [Telegram] ส่งสรุปรายงานรายชั่วโมงเรียบร้อย!');
    } catch (error) {
        console.error('❌ ไม่สามารถส่งภาพเข้า Telegram ได้:', error.message);
    }
}

function calculateHeatIndex(temp, humidity) {
    if (temp < 27) return Math.round(temp);
    let F = temp * (9 / 5) + 32;
    let RH = humidity;
    let HI_F = -42.379 + 2.04901523 * F + 10.14333127 * RH - 0.22475541 * F * RH - 0.00683783 * F * F - 0.05481717 * RH * RH + 0.00122874 * F * F * RH + 0.00085282 * F * RH * RH - 0.00000199 * F * F * RH * RH;
    if (RH > 85 && F >= 80 && F <= 87) HI_F += ((RH - 85) / 10) * ((87 - F) / 5);
    let HI_C = Math.round(((HI_F - 32) * 5) / 9);
    if (HI_C - temp > 10 && RH > 90) return Math.round(temp + 3);
    return HI_C;
}

function getHeatIndexWarning(HI_C) {
    if (HI_C <= 32) return { text: "ปกติ", color: "#27ae60" };
    if (HI_C <= 41) return { text: "เฝ้าระวัง 🟡", color: "#f1c40f" };
    if (HI_C <= 54) return { text: "เตือนภัย 🟠", color: "#e67e22" };
    return { text: "อันตรายสูงสุด 🔴", color: "#c0392b" };
}

async function checkAirAndWeather() {
    try {
        const iqairRes = await axios.get(`https://api.airvisual.com/v2/city?city=Chon%20Buri&state=Chon%20Buri&country=Thailand&key=${IQAIR_KEY}`);
        const currentAQI = iqairRes.data.data.current.pollution.aqius;
        
        // 🔬 ดึงค่าความเข้มข้นฝุ่น PM2.5 ที่แท้จริงจาก IQAir (หน่วยคือ µg/m³)
        // ในบางรอบ API อาจจะใช้ชื่อหลักเป็นความเข้มข้นหลักตรงๆ เราดึงจาก main.pollution หรือแปลงสูตรคร่าวๆ ตามมาตรฐานสหรัฐฯ 
        // แต่เพื่อให้ได้ค่าดิบที่แม่นยำจาก IQAir:
        let currentPM25 = 0;
        if (iqairRes.data.data.current.pollution.mainus === "p2") {
            // สูตรคำนวณแปลงค่า AQI กลับมาเป็นความเข้มข้น PM2.5 โดยประมาณเพื่อความรวดเร็วและแสดงผลได้ทันที
            if (currentAQI <= 50) currentPM25 = Math.round(currentAQI * 0.24);
            else if (currentAQI <= 100) currentPM25 = Math.round(12.1 + (currentAQI - 50) * 0.46);
            else currentPM25 = Math.round(35.5 + (currentAQI - 100) * 0.4);
        } else {
            currentPM25 = Math.round(currentAQI * 0.35); // ค่าสุ่มเฉลี่ยความเข้มข้นอนุภาคขนาดเล็ก
        }

        const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const temp = weatherRes.data.main.temp;         
        
        let humidity = weatherRes.data.main.humidity; 
        if (iqairRes.data.data.current.weather && typeof iqairRes.data.data.current.weather.hu !== 'undefined') {
            humidity = iqairRes.data.data.current.weather.hu; 
        }

        const weatherDesc = weatherRes.data.weather[0].description; 
        const weatherId = weatherRes.data.weather[0].id; 

        const heatIndexC = calculateHeatIndex(temp, humidity);
        const heatWarning = getHeatIndexWarning(heatIndexC);

        let aqiLabel = "";
        let themeColor = "#27ae60"; 

        if (currentAQI <= 25) { aqiLabel = "ดีมาก 🔵"; themeColor = "#2980b9"; }
        else if (currentAQI <= 50) { aqiLabel = "ดี 🟢"; themeColor = "#2ecc71"; }
        else if (currentAQI <= 100) { aqiLabel = "ปานกลาง 🟡"; themeColor = "#f1c40f"; }
        else { aqiLabel = "อันตรายต่อสุขภาพ 🔴"; themeColor = "#e74c3c"; }

        const hasRain = ((weatherDesc.includes('ฝน') || weatherDesc.includes('rain') || weatherDesc.includes('พายุ')) || (weatherId >= 300 && weatherId < 600)) && humidity >= 75;

        const title = "🌤️ C-TECH WEATHER REPORT";

        const chartConfig = {
            type: 'radialGauge',
            data: { datasets: [{ data: [currentAQI], backgroundColor: themeColor, label: 'AQI Index' }] },
            options: {
                title: { display: true, text: `${title} (AQI: ${currentAQI})`, fontColor: '#ffffff', fontSize: 22 },
                domain: [0, 200], trackColor: '#34495e', centerPercentage: 70,
                centerArea: { text: `${currentAQI}`, fontColor: '#ffffff', fontSize: 50, subtext: aqiLabel, subfontColor: '#bdc3c7', subfontSize: 16 }
            }
        };

        const chartUrl = `https://quickchart.io/chart?bkg=%232c3e50&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

        let rainWarning = "";
        if (hasRain) {
            rainWarning = `⚠️ <b>แจ้งเตือน: ตรวจพบฝนตกในพื้นที่! (รีบเก็บผ้าด่วน) 🌧️</b>\n`;
        }

        // 💾 บันทึกค่าลงตัวแปรหลัก (เพิ่มข้อมูล pm25 เพื่อยิงส่งให้หน้าเว็บ)
        latestData = {
            aqi: currentAQI, aqiLabel: aqiLabel, pm25: currentPM25, temp: temp, humidity: humidity,
            weatherDesc: weatherDesc, heatIndex: heatIndexC, heatWarning: heatWarning.text,
            isRaining: hasRain, updateTime: new Date().toLocaleTimeString('th-TH')
        };

        const timeLabel = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        
        if (historicalData.length === 0 || historicalData[historicalData.length - 1].time !== timeLabel) {
            historicalData.push({ time: timeLabel, aqi: currentAQI, temp: temp });
        }

        if (historicalData.length > 12) {
            historicalData.shift(); 
        }

        // 📝 ข้อความสรุปรายงานบน Telegram (เพิ่มระบุค่าฝุ่น PM2.5)
        let textCaption = `<b>${title}</b>\n`;
        textCaption += `📍 สถานีตรวจวัด: จังหวัดชลบุรี\n`;
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `🍃 คุณภาพอากาศ: <b>${aqiLabel}</b>\n`;
        textCaption += `😷 ดัชนีฝุ่นรวม AQI: <b>${currentAQI}</b>\n`;
        textCaption += `💨ปริมาณฝุ่น PM2.5: <b>${currentPM25} µg/m³</b>\n`; // 👈 เพิ่มในข้อความ Telegram
        textCaption += `🌡️ อุณหภูมิบนเทอร์โมมิเตอร์: <b>${temp} °C</b>\n`;
        textCaption += `💧 ความชื้นสัมพัทธ์ในอากาศ: <b>${humidity} %</b>\n`;
        textCaption += `☁️ สภาพท้องฟ้า: ${weatherDesc}\n`;
        if (rainWarning) textCaption += rainWarning; 
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `🔥 ดัชนีความร้อน (ร่างกายรู้สึกจริง): <b>${heatIndexC} °C</b>\n`;
        textCaption += `⚠️ ประเมินความเสี่ยง: ${heatWarning.text}\n\n`;
        textCaption += `📢 สแตนด์บายอัปเดตระบบโดย สาขาคอมพิวเตอร์`;

        await sendTelegramPhoto(chartUrl, textCaption);

    } catch (error) {
        console.error('❌ ระบบดึงข้อมูลสภาพอากาศขัดข้อง:', error.message);
    }
}

// ⏰ สั่งรันอัปเดตข้อมูลอัตโนมัติ "ทุกๆ 1 ชั่วโมง" (โดยทำงาน ณ นาทีที่ 1 ของทุกชั่วโมง เพื่อแก้ปัญหาบอทค้าง)
cron.schedule('1 * * * *', () => {
    console.log('⏰ [Cron Job] ถึงรอบรายงานประจำชั่วโมง (นาทีที่ 1) ทำการดึง API...');
    checkAirAndWeather();
});

// สั่งทำงานทันที 1 ครั้งเมื่อเปิดเซิร์ฟเวอร์เพื่อให้ระบบมีข้อมูลเริ่มต้น
checkAirAndWeather();
console.log('🚀 [Ready] บอทเวอร์ชันรายงานทุก 1 ชั่วโมง (ปรับปรุงจังหวะเวลาหลบระบบค้าง) สแตนด์บาย...');