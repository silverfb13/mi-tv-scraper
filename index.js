import axios from 'axios';
import { load } from 'cheerio';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';

async function loadChannels() {
    const xml = await fs.readFile('channels.xml', 'utf-8');
    const result = await parseStringPromise(xml);
    return result.channels.channel.map(c => ({
        id: c._.trim(),
        site_id: c.$.site_id.replace('br#', '').trim()
    }));
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds} +0000`;
}

function escapeXml(unsafe) {
    return unsafe.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function fetchChannelPrograms(channelId, date) {
    const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;
    const response = await axios.get(url);
    const $ = load(response.data);
    const programs = [];

    $('.schedule .cell').each((i, elem) => {
        const timeText = $(elem).find('.time').text().trim();
        const title = $(elem).find('.info .title').text().trim();
        const desc = $(elem).find('.info .description').text().trim();

        if (!timeText.includes('–')) return;

        let [startTime, endTime] = timeText.split('–').map(t => t.trim());

        // Converte horários para Date
        const start = new Date(`${date}T${startTime}:00Z`);
        let end = new Date(`${date}T${endTime}:00Z`);

        // Se o horário de fim for menor que o de início, é no dia seguinte
        if (end <= start) end.setUTCDate(end.getUTCDate() + 1);

        programs.push({
            start,
            end,
            title,
            desc
        });
    });

    return programs;
}

async function generateEPG() {
    const channels = await loadChannels();
    const dates = getTargetDates();
    let epg = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

    for (const channel of channels) {
        for (let i = 0; i < dates.length; i++) {
            const date = dates[i];
            const programs = await fetchChannelPrograms(channel.site_id, date);

            for (const program of programs) {
                const splitTime = new Date(`${date}T03:00:00Z`);

                if (program.end <= splitTime) {
                    // Programa termina antes de 03:00, manter normal no dia atual
                    epg += buildProgramXML(channel.id, program.start, program.end, program.title, program.desc);
                } else if (program.start >= splitTime) {
                    // Programa começa depois de 03:00, joga para o dia seguinte
                    const nextDay = new Date(program.start);
                    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
                    const nextDayStr = formatDate(nextDay);

                    const endNextDay = new Date(program.end);
                    endNextDay.setUTCDate(endNextDay.getUTCDate() + 1);
                    const endNextDayStr = formatDate(endNextDay);

                    epg += buildProgramXML(channel.id, nextDayStr, endNextDayStr, program.title, program.desc);
                } else {
                    // Programa atravessa 03:00, dividir
                    const firstPartEnd = splitTime;
                    epg += buildProgramXML(channel.id, program.start, firstPartEnd, program.title, program.desc);

                    const secondPartStart = splitTime;
                    const secondPartEnd = program.end;

                    const nextDay = new Date(date);
                    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
                    const nextDayStr = nextDay.toISOString().split('T')[0];

                    epg += buildProgramXML(channel.id, secondPartStart, secondPartEnd, program.title, program.desc, true);
                }
            }
        }
    }

    epg += '</tv>';
    await fs.writeFile('epg.xml', epg, 'utf-8');
    console.log('✅ EPG gerado com sucesso!');
}

function buildProgramXML(channelId, start, end, title, desc, isNextDay = false) {
    const startStr = formatDate(start);
    const endStr = formatDate(end);
    return `  <programme start="${startStr}" stop="${endStr}" channel="${channelId}">
    <title lang="pt">${escapeXml(title)}</title>
    <desc lang="pt">${escapeXml(desc)}</desc>
  </programme>\n`;
}

function getTargetDates() {
    const dates = [];
    const now = new Date();
    for (let i = -2; i <= 3; i++) {
        const date = new Date(now);
        date.setUTCDate(now.getUTCDate() + i);
        dates.push(date.toISOString().split('T')[0]);
    }
    return dates;
}

generateEPG();
