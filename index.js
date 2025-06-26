import axios from 'axios';
import { load } from 'cheerio';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';

function formatDate(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0];
}

function parseTime(date, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const d = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);
  return d;
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&apos;');
}

async function loadChannels() {
  const xml = await fs.readFile('channels.xml', 'utf-8');
  const result = await parseStringPromise(xml);
  return result.channels.channel.map(c => ({
    id: c._.trim(),
    site_id: c.$.site_id.replace('br#', '').trim()
  }));
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
        programs.push({
          time,
          title,
          desc: description || 'Sem descrição',
          rating: '[14]'
        });
      }
    });

    return programs;
  } catch (error) {
    console.error(`Erro ao buscar ${url}: ${error.message}`);
    return [];
  }
}

function getDates() {
  const dates = [];
  const today = new Date();

  for (let i = -1; i <= 2; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates;
}

async function generateEPG() {
  console.log('Carregando canais...');
  const channels = await loadChannels();
  console.log(`Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  channels.forEach(channel => {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
  });

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);

    for (const date of getDates()) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      if (programs.length === 0) continue;

      let lastProgramStart = parseTime(date, programs[programs.length - 1].time);

      for (let i = 0; i < programs.length; i++) {
        const current = programs[i];
        const next = programs[i + 1];

        let startDate = parseTime(date, current.time);
        let endDate = next ? parseTime(date, next.time) : new Date(startDate.getTime() + 60 * 60000);

        const originalStart = new Date(startDate);
        const originalEnd = new Date(endDate);

        const isBetweenMidnightAnd3 = startDate.getUTCHours() >= 0 && startDate.getUTCHours() < 3;
        const isBetween3AndLastProgram = startDate.getUTCHours() >= 3 && startDate < lastProgramStart;

        // Regra 1
        if (isBetweenMidnightAnd3) {
          startDate.setUTCDate(startDate.getUTCDate() + 1);
          endDate.setUTCDate(endDate.getUTCDate() + 1);
        }

        // Regra 2
        if (isBetween3AndLastProgram) {
          startDate.setUTCDate(startDate.getUTCDate() + 1);
          endDate.setUTCDate(endDate.getUTCDate() + 1);
        }

        // Regra 3 - dividir programa que atravessa 03:00
        if (originalStart.getUTCHours() < 3 && originalEnd.getUTCHours() >= 3 && originalEnd > originalStart) {
          const threeAM = new Date(originalStart);
          threeAM.setUTCHours(3, 0, 0, 0);

          // Primeira parte (antes das 03:00)
          epgXml += `  <programme start="${formatDate(originalStart)} +0000" stop="${formatDate(threeAM)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(current.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(current.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${current.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Segunda parte (depois das 03:00, no dia seguinte)
          const adjustedEnd = new Date(endDate);
          adjustedEnd.setUTCDate(adjustedEnd.getUTCDate() + 1);

          epgXml += `  <programme start="${formatDate(threeAM)} +0000" stop="${formatDate(adjustedEnd)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(current.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(current.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${current.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
        } else {
          // Programa normal
          epgXml += `  <programme start="${formatDate(startDate)} +0000" stop="${formatDate(endDate)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(current.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(current.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${current.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
        }
      }
    }
  }

  epgXml += '</tv>';
  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
