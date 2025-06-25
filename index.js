const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const xml2js = require('xml2js');

const CHANNELS_FILE = 'channels.xml';
const BASE_URL = 'https://mi.tv/br/async/channel';
const TIMEZONE_OFFSET = 0; // GMT 0000
const CUT_HOUR = 3;

async function fetchChannelList() {
    const xmlData = fs.readFileSync(CHANNELS_FILE, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    return result.channels.channel.map(c => ({ id: c.$.site_id, xmltv_id: c.$.xmltv_id }));
}

function getDatesToFetch() {
    const dates = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    for (let i = -2; i <= 3; i++) {
        const date = new Date(today);
        date.setUTCDate(date.getUTCDate() + i);
        dates.push(date.toISOString().split('T')[0]);
    }

    return dates;
}

function parseTime(timeStr) {
    const [hour, minute] = timeStr.split(':').map(Number);
    return hour + minute / 60;
}

function buildXMLTV(programsByDay) {
    const builder = new xml2js.Builder({ headless: true, cdata: true });
    const xmltv = { tv: { programme: [] } };

    for (const [channelId, days] of Object.entries(programsByDay)) {
        for (const [date, programs] of Object.entries(days)) {
            for (const program of programs) {
                xmltv.tv.programme.push({
                    $: {
                        start: `${program.start.replace(/[-:]/g, '').replace(' ', '')} +0000`,
                        stop: `${program.stop.replace(/[-:]/g, '').replace(' ', '')} +0000`,
                        channel: channelId
                    },
                    title: { _: program.title },
                    desc: { _: program.description }
                });
            }
        }
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.buildObject(xmltv);
}

function formatDateTime(date, time) {
    return `${date} ${time}:00`;
}

async function fetchAndProcessEPG() {
    const channels = await fetchChannelList();
    const dates = getDatesToFetch();
    const programsByDay = {};

    for (const channel of channels) {
        programsByDay[channel.xmltv_id] = {};

        for (let d = 0; d < dates.length; d++) {
            const date = dates[d];
            const nextDate = dates[d + 1] || null;

            const url = `${BASE_URL}/${channel.id}/${date}/0`;
            console.log(`Fetching: ${url}`);

            try {
                const response = await axios.get(url);
                const $ = cheerio.load(response.data);

                $('.schedule .item').each((_, el) => {
                    const time = $(el).find('.time').text().trim();
                    const title = $(el).find('.title').text().trim();
                    const description = $(el).find('.description').text().trim();

                    if (!time || !title) return;

                    const [startTime, endTime] = time.split(' - ').map(t => t.trim());

                    let startHour = parseTime(startTime);
                    let endHour = parseTime(endTime);

                    let startDate = date;
                    let endDate = date;

                    if (startHour > endHour) {
                        // Passou da meia-noite
                        endDate = nextDate;
                    }

                    let startTimestamp = new Date(`${startDate}T${startTime}:00Z`).getTime();
                    let endTimestamp = new Date(`${endDate}T${endTime}:00Z`).getTime();

                    const cutTimestamp = new Date(`${date}T0${CUT_HOUR}:00:00Z`).getTime();

                    if (endTimestamp <= cutTimestamp) {
                        // Todo o programa antes das 03:00
                        if (!programsByDay[channel.xmltv_id][date]) programsByDay[channel.xmltv_id][date] = [];
                        programsByDay[channel.xmltv_id][date].push({
                            start: formatDateTime(startDate, startTime),
                            stop: formatDateTime(endDate, endTime),
                            title,
                            description
                        });
                    } else if (startTimestamp >= cutTimestamp) {
                        // Todo o programa depois das 03:00, jogar para o próximo dia
                        if (!nextDate) return;
                        if (!programsByDay[channel.xmltv_id][nextDate]) programsByDay[channel.xmltv_id][nextDate] = [];
                        programsByDay[channel.xmltv_id][nextDate].push({
                            start: formatDateTime(startDate, startTime),
                            stop: formatDateTime(endDate, endTime),
                            title,
                            description
                        });
                    } else {
                        // Programa atravessa 03:00, separar
                        if (!programsByDay[channel.xmltv_id][date]) programsByDay[channel.xmltv_id][date] = [];
                        programsByDay[channel.xmltv_id][date].push({
                            start: formatDateTime(startDate, startTime),
                            stop: formatDateTime(date, '03:00'),
                            title,
                            description
                        });

                        if (!nextDate) return;
                        if (!programsByDay[channel.xmltv_id][nextDate]) programsByDay[channel.xmltv_id][nextDate] = [];
                        programsByDay[channel.xmltv_id][nextDate].push({
                            start: formatDateTime(date, '03:00'),
                            stop: formatDateTime(endDate, endTime),
                            title,
                            description
                        });
                    }
                });
            } catch (e) {
                console.error(`Erro ao buscar ${url}: ${e.message}`);
            }
        }
    }

    const xml = buildXMLTV(programsByDay);
    fs.writeFileSync('epg.xml', xml, 'utf-8');
    console.log('EPG gerado com sucesso!');
}

fetchAndProcessEPG();
