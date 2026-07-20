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

// 📌 ตัวแปรหลักสำหรับเก็บข้อมูลส่งให้หน้าเว็บ Frontend
let latestData = {
    aqi: 0,
    aqiLabel: "กำลังโหลด...",
    pm25: 0, 
    temp: 0,
    humidity: 0,
    weatherDesc: "กำลังโหลด...",
    heatIndex: 0,
    heatWarning: "กำลังโหลด...",
    isRaining: false,
    updateTime: "-",
    forecast: [] 
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
        console.log('🎨 [Telegram] ส่งสรุปรายงานเรียบร้อย!');
    } catch (error) {
        console.error('❌ ไม่สามารถส่งภาพเข้า Telegram ได้:', error.message);
    }
}

function calculateHeatIndex(temp, humidity) {
    if (temp < 27) return Math.round(temp);
    let F = temp * (9 / 5) + 32;
    let RH = humidity;
    let hi = 0.5 * (F + 61.0 + ((F - 68.0) * 1.2) + (RH * 0.094));
    if (hi >= 80) {
        hi = -42.379 + 2.04901523 * F + 10.14333127 * RH - 0.22475541 * F * RH 
             - 0.00683783 * F * F - 0.05481717 * RH * RH + 0.00122874 * F * F * RH 
             + 0.00085282 * F * RH * RH - 0.00000199 * F * F * RH * RH;
        if (RH < 13 && F >= 80 && F <= 112) hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(F - 95.)) / 17);
        else if (RH > 85 && F >= 80 && F <= 87) hi += ((RH - 85) / 10) * ((87 - F) / 5);
    }
    return Math.round(((hi - 32) * 5) / 9);
}

function getHeatIndexWarning(HI_C) {
    if (HI_C <= 32) return { text: "ปกติ", color: "#27ae60" };
    if (HI_C <= 41) return { text: "เฝ้าระวัง 🟡", color: "#f1c40f" };
    if (HI_C <= 54) return { text: "เตือนภัย 🟠", color: "#e67e22" };
    return { text: "อันตรายสูงสุด 🔴", color: "#c0392b" };
}

async function checkAirAndWeather() {
    try {
        // 1. ดึงข้อมูลคุณภาพอากาศ IQAir
        const iqairRes = await axios.get(`https://api.airvisual.com/v2/city?city=Chon%20Buri&state=Chon%20Buri&country=Thailand&key=${IQAIR_KEY}`);
        const currentAQI = iqairRes.data.data.current.pollution.aqius;
        
        let currentPM25 = 0;
        if (iqairRes.data.data.current.pollution.mainus === "p2") {
            if (currentAQI <= 50) currentPM25 = Math.round(currentAQI * 0.24);
            else if (currentAQI <= 100) currentPM25 = Math.round(12.1 + (currentAQI - 50) * 0.46);
            else currentPM25 = Math.round(35.5 + (currentAQI - 100) * 0.4);
        } else {
            currentPM25 = Math.round(currentAQI * 0.35); 
        }

        // 2. ดึงข้อมูลสภาพอากาศปัจจุบัน OpenWeatherMap
        const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const temp = weatherRes.data.main.temp;         
        let humidity = weatherRes.data.main.humidity; 
        if (iqairRes.data.data.current.weather && typeof iqairRes.data.data.current.weather.hu !== 'undefined') {
            humidity = iqairRes.data.data.current.weather.hu; 
        }
        const weatherDesc = weatherRes.data.weather[0].description; 
        const weatherId = weatherRes.data.weather[0].id; 

        // 3. 🔮 ระบบคัดกรองพยากรณ์ล่วงหน้า 3 วันแบบยืดหยุ่น (การันตีว่าข้อมูลไม่ว่าง)
        const forecastRes = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const forecastList = forecastRes.data.list;
        
        const dailyForecast = [];
        const checkedDates = [];
        const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });

        for (const item of forecastList) {
            const itemDate = new Date(item.dt * 1000);
            const itemDateStr = itemDate.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });

            if (itemDateStr !== todayStr && !checkedDates.includes(itemDateStr)) {
                const dayName = itemDate.toLocaleDateString('th-TH', { weekday: 'long' });
                dailyForecast.push({
                    day: dayName,
                    temp: Math.round(item.main.temp),
                    humidity: item.main.humidity,
                    desc: item.weather[0].description,
                    icon: item.weather[0].icon
                });
                checkedDates.push(itemDateStr);
                
                if (dailyForecast.length >= 3) break;
            }
        }

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

        const localTimeFormatted = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });

        latestData = {
            aqi: currentAQI, aqiLabel: aqiLabel, pm25: currentPM25, temp: temp, humidity: humidity,
            weatherDesc: weatherDesc, heatIndex: heatIndexC, heatWarning: heatWarning.text,
            isRaining: hasRain, updateTime: localTimeFormatted,
            forecast: dailyForecast
        };

        const timeLabel = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
        if (historicalData.length === 0 || historicalData[historicalData.length - 1].time !== timeLabel) {
            historicalData.push({ time: timeLabel, aqi: currentAQI, temp: temp });
        }
        if (historicalData.length > 12) historicalData.shift(); 

        let textCaption = `<b>${title}</b>\n`;
        textCaption += `📍 สถานีตรวจวัด: จังหวัดชลบุรี\n`;
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `🍃 คุณภาพอากาศ: <b>${aqiLabel}</b>\n`;
        textCaption += `😷 ดัชนีฝุ่นรวม AQI: <b>${currentAQI}</b>\n`;
        textCaption += `💨 ปริมาณฝุ่น PM2.5: <b>${currentPM25} µg/m³</b>\n`; 
        textCaption += `🌡️ อุณหภูมิบนเทอร์โมมิเตอร์: <b>${temp} °C</b>\n`;
        textCaption += `💧 ความชื้นสัมพัทธ์ in อากาศ: <b>${humidity} %</b>\n`;
        textCaption += `☁️ สภาพท้องฟ้า: ${weatherDesc}\n`;
        if (rainWarning) textCaption += rainWarning; 
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `🔥 ดัชนีความร้อน (ร่างกายรู้สึกจริง): <b>${heatIndexC} °C</b>\n`;
        textCaption += `⚠️ ประเมินความเสี่ยง: ${heatWarning.text}\n`;
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `💻 ดูแดชบอร์ดแบบเรียลไทม์ได้ที่:\n`;
        textCaption += `🔗 https://ctech-weather-aqi.onrender.com/\n\n`; 
        textCaption += `📢 สแตนด์บายอัปเดตระบบโดย สาขาคอมพิวเตอร์`;

        await sendTelegramPhoto(chartUrl, textCaption);

    } catch (error) {
        console.error('❌ ระบบดึงข้อมูลสภาพอากาศขัดข้อง:', error.message);
    }
}

cron.schedule('1 * * * *', () => {
    console.log('⏰ [Cron Job] ถึงรอบรายงานประจำชั่วโมง ทำการดึง API...');
    checkAirAndWeather();
});

checkAirAndWeather();
console.log('🚀 [Ready] บอทเวอร์ชันรายงานทุก 1 ชั่วโมงสแตนด์บาย...');