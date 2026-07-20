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

        // 3. 🔮 [แก้ไขตรงนี้] ปรับปรุงระบบคัดกรองพยากรณ์ล่วงหน้า 3 วันแบบการันตีผลลัพธ์
        const forecastRes = await axios.get(`https://api.openweathermap.org/data/2.5/forecast?q=Chonburi,TH&appid=${OPENWEATHER_KEY}&units=metric&lang=th`);
        const forecastList = forecastRes.data.list;
        
        const dailyForecast = [];
        const checkedDates = [];
        const todayStr = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });

        for (const item of forecastList) {
            const itemDate = new Date(item.dt * 1000);
            const itemDateStr = itemDate.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });

            // 💡 ถ้าเป็นวันถัดไป และยังไม่มีข้อมูลของวันนั้นในลิสต์ ให้ดึงข้อมูลรอบนั้นมาเป็นตัวแทนทันที
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
                
                // สิ้นสุดเมื่อได้ครบ 3 วันล่วงหน้า
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

        // บันทึกข้อมูลลงตัวแปรหลัก
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

        // 📝 ข้อความสรุปรายงานบน Telegram
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