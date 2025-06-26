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
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

function escapeXml(unsafe) {
    return unsafe.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function getDates() {
    const dates = [];
    const now = new Date();

    // GMT +0000 (não precisa ajustar timezone)
    for (let i = -1; i <= 2; i++) {
        const date = new Date(now);
        date.setDate(now.getDate() + i);
        dates.push(date.toISOString().split('T')[0]);
    }

    return dates.slice(0, 4); // Ontem, hoje, amanhã, depois de amanhã
}

async function fetchChannelPrograms(channelId, date) {
    const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;

    try {
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = load(response.data);
        const programs = [];

        $('li').each((_, element) => {
            const time = $(element).find('.time').text().trim();
            const title = $(element).find('h2').text().trim();
            const description = $(element).find('.synopsis').text().trim();

            if (time && title) {
                const [hours, minutes] = time.split(':').map(Number);
                const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);
                programs.push({
                    startDate,
                    title,
                    desc: description || 'Sem descrição'
                });
            }
        });

        return programs;
    } catch (error) {
        console.error(`Erro ao buscar ${url}: ${error.message}`);
        return [];
    }
}

async function generateEPG() {
    console.log('🔍 Carregando canais...');
    const channels = await loadChannels();
    console.log(`🎯 Total de canais encontrados: ${channels.length}`);

    let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

    channels.forEach(channel => {
        epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
    });

    for (const channel of channels) {
        console.log(`📺 Buscando EPG para ${channel.id}...`);

        const dates = getDates();
        let allPrograms = {};

        // Buscar todos os dias para depois comparar
        for (const date of dates) {
            const programs = await fetchChannelPrograms(channel.site_id, date);
            allPrograms[date] = programs;
        }

        for (let i = 0; i < dates.length; i++) {
            const currentDate = dates[i];
            const currentPrograms = allPrograms[currentDate];
            const nextDate = dates[i + 1];
            const nextPrograms = allPrograms[nextDate] || [];

            if (currentPrograms.length === 0) continue;

            // Capturar horário do primeiro programa do dia seguinte
            let firstNextStart = null;
            if (nextPrograms.length > 0) {
                firstNextStart = nextPrograms[0].startDate;
            }

            for (let j = 0; j < currentPrograms.length; j++) {
                const program = currentPrograms[j];
                let start = new Date(program.startDate);
                let channelDay = currentDate; // Por padrão, ele pertence ao mesmo dia no XML

                // Regras:
                if (start.getUTCHours() >= 0 && start.getUTCHours() < 3) {
                    // Entre 00:00 e 03:00 ➜ adianta 1 dia no horário, mas mantém no mesmo dia no XML
                    start.setUTCDate(start.getUTCDate() + 1);
                } else if (firstNextStart && start >= new Date(`${currentDate}T03:00:00Z`) && start < firstNextStart) {
                    // Entre 03:00 e o início do primeiro programa do dia seguinte ➜ muda para o próximo dia no XML
                    const tempDate = new Date(channelDay);
                    tempDate.setDate(tempDate.getDate() + 1);
                    channelDay = tempDate.toISOString().split('T')[0];
                }

                let end;
                if (j + 1 < currentPrograms.length) {
                    end = new Date(currentPrograms[j + 1].startDate);
                } else if (nextPrograms.length > 0) {
                    end = new Date(nextPrograms[0].startDate);
                } else {
                    // Se não houver próximo programa, adiciona 1h
                    end = new Date(start.getTime() + 60 * 60000);
                }

                const startString = `${formatDate(start)} +0000`;
                const endString = `${formatDate(end)} +0000`;

                epgXml += `  <programme start="${startString}" stop="${endString}" channel="${channel.id}">\n`;
                epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
                epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
                epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
                epgXml += `  </programme>\n`;
            }
        }
    }

    epgXml += '</tv>';

    await fs.writeFile('epg.xml', epgXml, 'utf-8');
    console.log('✅ EPG gerado com sucesso em epg.xml');
}

generateEPG();
