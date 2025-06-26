const axios = require('axios');
const fs = require('fs');
const { parseStringPromise, Builder } = require('xml2js');

const CHANNELS_FILE = 'channels.xml';
const OUTPUT_FILE = 'epg.xml';

async function loadChannels() {
    const data = fs.readFileSync(CHANNELS_FILE, 'utf-8');
    const channels = [];
    const result = await parseStringPromise(data);
    result.channels.channel.forEach(ch => {
        channels.push({
            id: ch.$.xmltv_id,
            name: ch._
        });
    });
    return channels;
}

function getDates() {
    const now = new Date();
    const dates = [];
    for (let i = -1; i <= 2; i++) { // ontem, hoje, amanhã, depois de amanhã
        const date = new Date(now);
        date.setUTCDate(date.getUTCDate() + i);
        const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(date.getUTCDate()).padStart(2, '0');
        dates.push(`${yyyy}-${mm}-${dd}`);
    }
    return dates;
}

function parseTimeToMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
}

function addMinutes(date, minutesToAdd) {
    const newDate = new Date(date.getTime() + minutesToAdd * 60000);
    return newDate;
}

function formatDate(date) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${yyyy}${mm}${dd}${hh}${min}00 +0000`;
}

async function fetchEPG(channel, date) {
    const url = `https://mi.tv/br/async/channel/${channel.id}/${date}/0`;
    try {
        const { data } = await axios.get(url);
        return data;
    } catch (error) {
        console.error(`Erro ao buscar: ${url}`);
        return '';
    }
}

async function processChannel(channel) {
    const dates = getDates();
    const programmes = [];

    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const nextDate = dates[i + 1];

        if (!nextDate && i < 3) continue;

        const html = await fetchEPG(channel, date);
        const regex = /<li[^>]*>.*?<span class="time">([\d:]+)<\/span>.*?<h2>(.*?)<\/h2>.*?<span class="sub-title">(.*?)<\/span>.*?<p class="synopsis">\s*(.*?)\s*<\/p>.*?<\/li>/gs;

        const matches = [...html.matchAll(regex)];

        let dayStart = new Date(`${date}T00:00:00Z`);
        let nextDayStart = new Date(`${nextDate}T00:00:00Z`);

        for (let j = 0; j < matches.length; j++) {
            const [, time, title, category, desc] = matches[j];
            const startTime = parseTimeToMinutes(time);
            let startDate = addMinutes(dayStart, startTime);

            let endDate;

            if (j + 1 < matches.length) {
                const nextTime = parseTimeToMinutes(matches[j + 1][1]);
                endDate = addMinutes(dayStart, nextTime);
            } else {
                endDate = addMinutes(startDate, 60); // default: 1h
            }

            // Regra entre 00:00 e 03:00
            if (startTime >= 0 && startTime < 180) {
                startDate = addMinutes(startDate, 1440);
                endDate = addMinutes(endDate, 1440);
            }

            // Regra de mover após 03:00 para o próximo dia
            if (startTime >= 180 && i < 3) {
                programmes.push({
                    channel: channel.id,
                    start: formatDate(startDate),
                    stop: formatDate(endDate),
                    title: title.trim(),
                    desc: desc.trim(),
                    category: category.trim()
                });
            } else if (startTime < 180 || i === 3) {
                programmes.push({
                    channel: channel.id,
                    start: formatDate(startDate),
                    stop: formatDate(endDate),
                    title: title.trim(),
                    desc: desc.trim(),
                    category: category.trim()
                });
            }
        }
    }

    return programmes;
}

async function buildEPG() {
    const channels = await loadChannels();
    const epg = { tv: { channel: [], programme: [] } };

    channels.forEach(channel => {
        epg.tv.channel.push({
            id: channel.id,
            'display-name': channel.name
        });
    });

    for (const channel of channels) {
        console.log(`Processando canal: ${channel.name}`);
        const programmes = await processChannel(channel);
        programmes.forEach(p => {
            epg.tv.programme.push({
                $: {
                    start: p.start,
                    stop: p.stop,
                    channel: p.channel
                },
                title: { _: p.title },
                desc: { _: p.desc },
                category: { _: p.category }
            });
        });
    }

    const builder = new Builder();
    const xml = builder.buildObject(epg);
    fs.writeFileSync(OUTPUT_FILE, xml);
    console.log('EPG atualizado com sucesso!');
}

buildEPG();
