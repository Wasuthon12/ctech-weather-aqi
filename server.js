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

// 📌 ตัวแปรจำสถานะระดับฝุ่นวิกฤต
let lastPM25AlertLevel = "Safe"; // Safe, Warning, Danger

// 📌 ตัวแปรหลักสำหรับเก็บข้อมูลส่งให้ Frontend
let latestData = {
    aqi: 0,
    aqiLabel: "กำลังโหลด...",
    pm25: 0, 
    temp: 0,
    humidity: 0,
    weatherDesc: "กำลังโหลด...",
    heatIndex: 0,
    heatWarning: "กำลังโหลด...",
    uvIndex: 0,
    uvLabel: "กำลังโหลด...",
    isRaining: false,
    updateTime: "-",
    forecast: [],
    comparison: {
        pattaya: { aqi: 0, pm25: 0, label: "กำลังโหลด..." },
        siracha: { aqi: 0, pm25: 0, label: "กำลังโหลด..." }
    }
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

// 🚨 ฟังก์ชันส่งข้อความเตือนภัยด่วน
async function sendTelegramAlert(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHANNEL,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('🚨 [Telegram Alert] ส่งข้อความแจ้งเตือนวิกฤตด่วนเรียบร้อย!');
    } catch (error) {
        console.error('❌ ไม่สามารถส่งข้อความแจ้งเตือนด่วนเข้า Telegram ได้:', error.message);
    }
}

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

// 🌡️ ฟังก์ชันคำนวณ Heat Index แบบปรับสมดุล
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
    if (hiC > maxAllowed) {
        hiC = maxAllowed;
    }

    return Math.round(hiC);
}

// ⚠️ ระดับการเตือนภัยดัชนีความร้อน
function getHeatIndexWarning(HI_C) {
    if (HI_C < 27.0) return { text: "ปกติ 🟢", color: "#27ae60" };
    if (HI_C <= 32.9) return { text: "เฝ้าระวัง 🟢", color: "#2ecc71" };
    if (HI_C <= 41.9) return { text: "เตือนภัย 🟡", color: "#f1c40f" };
    if (HI_C <= 51.9) return { text: "อันตราย 🟠", color: "#e67e22" };
    return { text: "อันตรายมาก 🔴", color: "#c0392b" };
}

async function checkAirAndWeather(isHourlyReport = false) {
    try {
        // 1. IQAir ชลบุรี
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

        // พัทยา
        let pattayaData = { aqi: 0, pm25: 0, label: "ไม่มีข้อมูล" };
        try {
            const pattayaRes = await axios.get(`https://api.airvisual.com/v2/city?city=Pattaya&state=Chon%20Buri&country=Thailand&key=${IQAIR_KEY}`);
            const pAQI = pattayaRes.data.data.current.pollution.aqius;
            let pPM25 = Math.round(pAQI * 0.35);
            let pLabel = pAQI <= 25 ? "ดีมาก 🔵" : pAQI <= 50 ? "ดี 🟢" : pAQI <= 100 ? "ปานกลาง 🟡" : "เริ่มมีผลกระทบ 🟠";
            pattayaData = { aqi: pAQI, pm25: pPM25, label: pLabel };
        } catch (e) { 
            try {
                const lamungRes = await axios.get(`https://api.airvisual.com/v2/city?city=Bang%20Lamung&state=Chon%20Buri&country=Thailand&key=${IQAIR_KEY}`);
                const pAQI = lamungRes.data.data.current.pollution.aqius;
                let pPM25 = Math.round(pAQI * 0.35);
                let pLabel = pAQI <= 25 ? "ดีมาก 🔵" : pAQI <= 50 ? "ดี 🟢" : pAQI <= 100 ? "ปานกลาง 🟡" : "เริ่มมีผลกระทบ 🟠";
                pattayaData = { aqi: pAQI, pm25: pPM25, label: pLabel };
            } catch (errLamung) {
                console.error("❌ สถานีสำรองบางละมุงขัดข้อง:", errLamung.message);
            }
        }

        // ศรีราชา
        let sirachaData = { aqi: 0, pm25: 0, label: "ไม่มีข้อมูล" };
        try {
            const sirachaRes = await axios.get(`https://api.airvisual.com/v2/city?city=Si%20Racha&state=Chon%20Buri&country=Thailand&key=${IQAIR_KEY}`);
            const sAQI = sirachaRes.data.data.current.pollution.aqius;
            let sPM25 = Math.round(sAQI * 0.35);
            let sLabel = sAQI <= 25 ? "ดีมาก 🔵" : sAQI <= 50 ? "ดี 🟢" : sAQI <= 100 ? "ปานกลาง 🟡" : "เริ่มมีผลกระทบ 🟠";
            sirachaData = { aqi: sAQI, pm25: sPM25, label: sLabel };
        } catch (e) { 
            console.log("⚠️ ดึงข้อมูลศรีราชาขัดข้อง:", e.message); 
        }

        // 2. OpenWeatherMap
        const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const temp = weatherRes.data.main.temp;         
        let humidity = weatherRes.data.main.humidity; 
        if (iqairRes.data.data.current.weather && typeof iqairRes.data.data.current.weather.hu !== 'undefined') {
            humidity = iqairRes.data.data.current.weather.hu; 
        }
        const weatherDesc = weatherRes.data.weather[0].description; 
        const weatherId = weatherRes.data.weather[0].id; 

        // ☀️ 2.1 คำนวณ/ดึงค่า UV Index
        let uvIndex = 0;
        const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })).getHours();
        
        if (currentHour >= 6 && currentHour <= 18) {
            try {
                const uvRes = await axios.get(`https://api.openweathermap.org/data/2.5/uvi?lat=13.3611&lon=100.9847&appid=${OPENWEATHER_KEY}`);
                uvIndex = Math.round(uvRes.data.value);
            } catch (uvErr) {
                const peakFactor = Math.sin((currentHour - 6) / 12 * Math.PI);
                uvIndex = Math.round(peakFactor * (temp > 33 ? 10 : 7));
            }
        }

        let uvLabel = "ต่ำ 🟢";
        if (uvIndex >= 11) uvLabel = "สุดขีด 🟣";
        else if (uvIndex >= 8) uvLabel = "สูงมาก 🔴";
        else if (uvIndex >= 6) uvLabel = "สูง 🟠";
        else if (uvIndex >= 3) uvLabel = "ปานกลาง 🟡";

        // 3. 🔮 พยากรณ์ล่วงหน้า 3 วัน
        const forecastRes = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const forecastList = forecastRes.data.list;
        
        const dailyForecast = [];
        const checkedDates = new Set();

        const nowInThailand = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
        const todayDateNum = nowInThailand.getDate();

        for (const item of forecastList) {
            const itemDate = new Date(new Date(item.dt * 1000).toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const itemDateNum = itemDate.getDate();

            if (itemDateNum !== todayDateNum && !checkedDates.has(itemDateNum)) {
                const dayName = itemDate.toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'Asia/Bangkok' });
                dailyForecast.push({
                    day: dayName,
                    temp: Math.round(item.main.temp),
                    humidity: item.main.humidity,
                    desc: item.weather[0].description,
                    icon: item.weather[0].icon
                });
                checkedDates.add(itemDateNum);
                
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

        const localTimeFormatted = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });

        latestData = {
            aqi: currentAQI, aqiLabel: aqiLabel, pm25: currentPM25, temp: temp, humidity: humidity,
            weatherDesc: weatherDesc, heatIndex: heatIndexC, heatWarning: heatWarning.text,
            uvIndex: uvIndex, uvLabel: uvLabel,
            isRaining: hasRain, updateTime: localTimeFormatted,
            forecast: dailyForecast,
            comparison: {
                pattaya: pattayaData,
                siracha: sirachaData
            }
        };

        const timeLabel = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
        if (historicalData.length === 0 || historicalData[historicalData.length - 1].time !== timeLabel) {
            historicalData.push({ time: timeLabel, aqi: currentAQI, temp: temp });
        }
        if (historicalData.length > 12) historicalData.shift(); 

        // 🚨 แจ้งเตือนด่วน PM2.5
        let currentAlertLevel = "Safe";
        if (currentPM25 > 55) {
            currentAlertLevel = "Danger";
        } else if (currentPM25 > 35) {
            currentAlertLevel = "Warning";
        }

        if (currentAlertLevel !== lastPM25AlertLevel && currentAlertLevel !== "Safe") {
            lastPM25AlertLevel = currentAlertLevel; 
            
            let alertMsg = `🚨 <b>[แจ้งเตือนด่วน! วิกฤตฝุ่น PM2.5 เกินมาตรฐาน]</b> 🚨\n`;
            alertMsg += `📍 พิกัดสถานี: จังหวัดชลบุรี\n`;
            alertMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
            if (currentAlertLevel === "Danger") {
                alertMsg += `🔴 <b>ระดับอันตรายสูงสุด: ${currentPM25} µg/m³</b>\n`;
                alertMsg += `⚠️ <i>คำแนะนำ: ดัชนีมลพิษสูงเกินเกณฑ์ความปลอดภัยอย่างมาก หลีกเลี่ยงกิจกรรมกลางแจ้ง และสวมหน้ากากอนามัยทันที!</i>\n`;
            } else {
                alertMsg += `🟡 <b>ระดับเริ่มมีผลกระทบต่อสุขภาพ: ${currentPM25} µg/m³</b>\n`;
                alertMsg += `⚠️ <i>คำแนะนำ: ปริมาณฝุ่นเริ่มหนาแน่น นักศึกษาและกลุ่มเสี่ยงควรลดระยะเวลาทำกิจกรรมกลางแจ้ง</i>\n`;
            }
            alertMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
            alertMsg += `⏰ ตรวจพบเวลา: ${localTimeFormatted}\n`;
            alertMsg += `💻 ดูรายละเอียดกราฟสด: https://ctech-weather-aqi.onrender.com/`;

            await sendTelegramAlert(alertMsg);
        }
        else if (currentAlertLevel === "Safe" && lastPM25AlertLevel !== "Safe") {
            lastPM25AlertLevel = "Safe";
            console.log("🍃 [Alert System] สภาพอากาศกลับเข้าสู่สภาวะปกติเรียบร้อย");
        }

        // 📊 สรุปรายงานรายชั่วโมง
        if (isHourlyReport) {
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
                rainWarning = `⚠️ <b>แจ้งเตือน: ตรวจพบฝนตกในพื้นที่! (รีบเข้าตึกด่วน) 🌧️</b>\n`;
            }

            let textCaption = `<b>${title}</b>\n`;
            textCaption += `📍 สถานีตรวจวัด: จังหวัดชลบุรี\n`;
            textCaption += `━━━━━━━━━━━━━━━━━━━━\n`;
            textCaption += `🍃 คุณภาพอากาศ: <b>${aqiLabel}</b>\n`;
            textCaption += `😷 ดัชนีฝุ่นรวม AQI: <b>${currentAQI}</b>\n`;
            textCaption += `💨 ปริมาณฝุ่น PM2.5: <b>${currentPM25} µg/m³</b>\n`; 
            textCaption += `☀️ ดัชนีรังสี UV: <b>${uvIndex} (${uvLabel})</b>\n`; 
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
        }

    } catch (error) {
        console.error('❌ ระบบดึงข้อมูลสภาพอากาศขัดข้อง:', error.message);
    }
}

cron.schedule('1 * * * *', () => {
    console.log('⏰ [Cron Job] ถึงรอบรายงานประจำชั่วโมง ทำการดึง API พร้อมส่งภาพ...');
    checkAirAndWeather(true); 
});

checkAirAndWeather(true);
console.log('🚀 [Ready] บอทเวอร์ชันแจ้งเตือนภัย PM2.5 ด่วน Real-time สแตนด์บาย...');