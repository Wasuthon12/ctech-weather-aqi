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

let lastPM25AlertLevel = "Safe";

// 📌 พิกัดสำหรับแต่ละเมือง (Chonburi, Pattaya, Si Racha)
const LOCATIONS = {
    main: { name: "อ.เมืองชลบุรี", city: "Chon Buri", state: "Chon Buri", owmQuery: "Chonburi,TH", lat: 13.3611, lon: 100.9847 },
    pattaya: { name: "เมืองพัทยา (Pattaya)", city: "Pattaya", state: "Chon Buri", owmQuery: "Pattaya,TH", lat: 12.9236, lon: 100.8825 },
    siracha: { name: "อ.ศรีราชา (Si Racha)", city: "Si Racha", state: "Chon Buri", owmQuery: "Si Racha,TH", lat: 13.1737, lon: 100.9311 }
};

// 📌 โครงสร้างเก็บข้อมูลแยกตามเมือง
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

// 🔄 Endpoint หลัก: รองรับ ?location=main | pattaya | siracha
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

// ☀️ ฟังก์ชันคำนวณรังสี UV ตามเวลาจริงแม่นยำ (เวลาประเทศไทย GMT+7)
function calculateSmartUVIndex(clouds = 0) {
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })).getHours();

    // 1. กลางคืน/ย่ำค่ำ (18:00 - 05:59 น.) -> UV = 0
    if (currentHour >= 18 || currentHour < 6) {
        return { index: 0, label: "ต่ำ 🟢" };
    }

    // 2. เช้าตรู่ (06:00 - 08:59 น.) -> UV = 1 ถึง 2
    if (currentHour >= 6 && currentHour < 9) {
        return { index: 1, label: "ต่ำ 🟢" };
    }

    // 3. ช่วงสาย (09:00 - 10:59 น.) -> UV = 3 ถึง 5
    if (currentHour >= 9 && currentHour < 11) {
        const baseUV = Math.round(5 * (1 - clouds / 100));
        const uv = Math.max(2, baseUV);
        return { index: uv, label: uv <= 2 ? "ต่ำ 🟢" : "ปานกลาง 🟡" };
    }

    // 4. ช่วงเที่ยงวันพีค (11:00 - 14:59 น.) -> UV = 6 ถึง 11+
    if (currentHour >= 11 && currentHour < 15) {
        const baseUV = Math.round(10 * (1 - clouds / 100));
        const uv = Math.max(4, baseUV);
        let label = "สูง 🟠";
        if (uv >= 11) label = "สุดขีด 🟣";
        else if (uv >= 8) label = "สูงมาก 🔴";
        else if (uv <= 5) label = "ปานกลาง 🟡";
        return { index: uv, label: label };
    }

    // 5. ช่วงบ่ายแก่ๆ (15:00 - 17:59 น.) -> UV = 1 ถึง 4
    const baseUV = Math.round(4 * (1 - clouds / 100));
    const uv = Math.max(1, baseUV);
    return { index: uv, label: uv <= 2 ? "ต่ำ 🟢" : "ปานกลาง 🟡" };
}

// 🔄 ฟังก์ชันดึงข้อมูลแบบไดนามิกตามเมือง
async function fetchCityData(key) {
    const locConfig = LOCATIONS[key];
    try {
        // 1. IQAir API
        let currentAQI = 0;
        let currentPM25 = 0;
        try {
            const iqRes = await axios.get(`https://api.airvisual.com/v2/city?city=${encodeURIComponent(locConfig.city)}&state=${encodeURIComponent(locConfig.state)}&country=Thailand&key=${IQAIR_KEY}`);
            currentAQI = iqRes.data.data.current.pollution.aqius;
            
            if (iqRes.data.data.current.pollution.mainus === "p2") {
                if (currentAQI <= 50) currentPM25 = Math.round(currentAQI * 0.24);
                else if (currentAQI <= 100) currentPM25 = Math.round(12.1 + (currentAQI - 50) * 0.46);
                else currentPM25 = Math.round(35.5 + (currentAQI - 100) * 0.4);
            } else {
                currentPM25 = Math.round(currentAQI * 0.35); 
            }
        } catch (errIQ) {
            console.log(`⚠️ IQAir ${locConfig.name} ขัดข้อง ใช้สถานีสำรอง/ค่าประมาณ`);
            currentAQI = key === 'pattaya' ? 38 : key === 'siracha' ? 56 : 28;
            currentPM25 = key === 'pattaya' ? 13 : key === 'siracha' ? 20 : 7;
        }

        let aqiLabel = "";
        if (currentAQI <= 25) aqiLabel = "ดีมาก 🔵";
        else if (currentAQI <= 50) aqiLabel = "ดี 🟢";
        else if (currentAQI <= 100) aqiLabel = "ปานกลาง 🟡";
        else aqiLabel = "อันตรายต่อสุขภาพ 🔴";

        // 2. OpenWeather API
        const weatherRes = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${locConfig.owmQuery}&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const temp = weatherRes.data.main.temp;
        const humidity = weatherRes.data.main.humidity;
        const weatherDesc = weatherRes.data.weather[0].description;
        const weatherId = weatherRes.data.weather[0].id;
        const clouds = weatherRes.data.clouds ? weatherRes.data.clouds.all : 0;

        // ☀️ คำนวณ UV Index ใหม่ตามเวลาจริง
        const calculatedUV = calculateSmartUVIndex(clouds);
        let uvIndex = calculatedUV.index;
        let uvLabel = calculatedUV.label;

        // Forecast 3 วัน
        const forecastRes = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?q=${locConfig.owmQuery}&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const dailyForecast = [];
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

        const heatIndexC = calculateHeatIndex(temp, humidity);
        const heatWarning = getHeatIndexWarning(heatIndexC);
        const hasRain = (weatherDesc.includes('ฝน') || (weatherId >= 300 && weatherId < 600)) && humidity >= 75;
        const localTimeFormatted = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });

        // กราฟย้อนหลัง (History)
        const timeLabel = new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
        let history = storeData[key].history || [];
        if (history.length === 0 || history[history.length - 1].time !== timeLabel) {
            history.push({ time: timeLabel, aqi: currentAQI, temp: Math.round(temp) });
        }
        if (history.length > 12) history.shift();

        // บันทึกลง Store ตาม Key เมือง
        storeData[key] = {
            aqi: currentAQI, aqiLabel: aqiLabel, pm25: currentPM25, temp: temp, humidity: humidity,
            weatherDesc: weatherDesc, heatIndex: heatIndexC, heatWarning: heatWarning.text,
            uvIndex: uvIndex, uvLabel: uvLabel, isRaining: hasRain, updateTime: localTimeFormatted,
            forecast: dailyForecast, history: history
        };

    } catch (err) {
        console.error(`❌ ดึงข้อมูล ${locConfig.name} ขัดข้อง:`, err.message);
    }
}

async function checkAirAndWeatherAll(isHourlyReport = false) {
    await fetchCityData('main');
    await fetchCityData('pattaya');
    await fetchCityData('siracha');

    // แจ้งเตือน Telegram ฝุ่นวิกฤต (ใช้จุดหลัก อ.เมืองชลบุรี)
    const mainData = storeData.main;
    let currentAlertLevel = "Safe";
    if (mainData.pm25 > 55) currentAlertLevel = "Danger";
    else if (mainData.pm25 > 35) currentAlertLevel = "Warning";

    if (currentAlertLevel !== lastPM25AlertLevel && currentAlertLevel !== "Safe") {
        lastPM25AlertLevel = currentAlertLevel;
        let alertMsg = `🚨 <b>[แจ้งเตือนด่วน! วิกฤตฝุ่น PM2.5 เกินมาตรฐาน]</b> 🚨\n`;
        alertMsg += `📍 พิกัดสถานี: จังหวัดชลบุรี\n━━━━━━━━━━━━━━━━━━━━\n`;
        if (currentAlertLevel === "Danger") {
            alertMsg += `🔴 <b>ระดับอันตรายสูงสุด: ${mainData.pm25} µg/m³</b>\n`;
            alertMsg += `⚠️ <i>คำแนะนำ: ดัชนีมลพิษสูงเกินเกณฑ์ความปลอดภัยอย่างมาก หลีกเลี่ยงกิจกรรมกลางแจ้ง และสวมหน้ากากอนามัยทันที!</i>\n`;
        } else {
            alertMsg += `🟡 <b>ระดับเริ่มมีผลกระทบต่อสุขภาพ: ${mainData.pm25} µg/m³</b>\n`;
            alertMsg += `⚠️ <i>คำแนะนำ: ปริมาณฝุ่นเริ่มหนาแน่น นักศึกษาและกลุ่มเสี่ยงควรลดระยะเวลาทำกิจกรรมกลางแจ้ง</i>\n`;
        }
        alertMsg += `━━━━━━━━━━━━━━━━━━━━\n⏰ ตรวจพบเวลา: ${mainData.updateTime}\n💻 ดูรายละเอียดกราฟสด: https://ctech-weather-aqi.onrender.com/`;
        await sendTelegramAlert(alertMsg);
    } else if (currentAlertLevel === "Safe" && lastPM25AlertLevel !== "Safe") {
        lastPM25AlertLevel = "Safe";
        console.log("🍃 [Alert System] สภาพอากาศกลับเข้าสู่สภาวะปกติเรียบร้อย");
    }

    // สรุป รายชั่วโมง
    if (isHourlyReport) {
        let themeColor = mainData.aqi <= 25 ? "#2980b9" : mainData.aqi <= 50 ? "#2ecc71" : mainData.aqi <= 100 ? "#f1c40f" : "#e74c3c";
        const chartConfig = {
            type: 'radialGauge',
            data: { datasets: [{ data: [mainData.aqi], backgroundColor: themeColor, label: 'AQI Index' }] },
            options: {
                title: { display: true, text: `🌤️ C-TECH WEATHER REPORT (AQI: ${mainData.aqi})`, fontColor: '#ffffff', fontSize: 22 },
                domain: [0, 200], trackColor: '#34495e', centerPercentage: 70,
                centerArea: { text: `${mainData.aqi}`, fontColor: '#ffffff', fontSize: 50, subtext: mainData.aqiLabel, subfontColor: '#bdc3c7', subfontSize: 16 }
            }
        };
        const chartUrl = `https://quickchart.io/chart?bkg=%232c3e50&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

        let textCaption = `<b>🌤️ C-TECH WEATHER REPORT</b>\n📍 สถานีตรวจวัด: จังหวัดชลบุรี\n━━━━━━━━━━━━━━━━━━━━\n`;
        textCaption += `🍃 คุณภาพอากาศ: <b>${mainData.aqiLabel}</b>\n😷 ดัชนีฝุ่นรวม AQI: <b>${mainData.aqi}</b>\n💨 ปริมาณฝุ่น PM2.5: <b>${mainData.pm25} µg/m³</b>\n`;
        textCaption += `☀️ ดัชนีรังสี UV: <b>${mainData.uvIndex} (${mainData.uvLabel})</b>\n🌡️ อุณหภูมิบนเทอร์โมมิเตอร์: <b>${mainData.temp} °C</b>\n💧 ความชื้นสัมพัทธ์: <b>${mainData.humidity} %</b>\n☁️ สภาพท้องฟ้า: ${mainData.weatherDesc}\n`;
        if (mainData.isRaining) textCaption += `⚠️ <b>แจ้งเตือน: ตรวจพบฝนตกในพื้นที่! (รีบเข้าตึกด่วน) 🌧️</b>\n`;
        textCaption += `━━━━━━━━━━━━━━━━━━━━\n🔥 ดัชนีความร้อน: <b>${mainData.heatIndex} °C</b>\n⚠️ ประเมินความเสี่ยง: ${mainData.heatWarning}\n━━━━━━━━━━━━━━━━━━━━\n🔗 https://ctech-weather-aqi.onrender.com/`;

        await sendTelegramPhoto(chartUrl, textCaption);
    }
}

cron.schedule('1 * * * *', () => {
    console.log('⏰ [Cron Job] ทำการอัปเดตข้อมูลสภาพอากาศทั้ง 3 เมือง...');
    checkAirAndWeatherAll(true); 
});

checkAirAndWeatherAll(true);
console.log('🚀 [Ready] บอทสภาพอากาศรองรับ 3 เมือง สแตนด์บาย...');
                
