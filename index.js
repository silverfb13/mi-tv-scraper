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

async function fetchChannelPrograms(channelId, date) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = load(response.data);
    const programs = [];

    $('li.card-program').each((_, element) => {
      const start = $(element).attr('data-start');
      const end = $(element).attr('data-end');

      if (start && end) {
        const title = $(element).find('.program-title').text().trim() || 'Sem título';
        const description = $(element).find('.synopsis').text().trim() || 'Sem descrição';

        const startDate = new Date(start);
        const endDate = new Date(end);

        programs.push({
          start: startDate,
          end: endDate,
          title,
          desc: description,
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

function formatDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

function getDates() {
  const dates = [];
  const now = new Date();

  for (let i = -1; i <= 2; i++) {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates;
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&apos;');
}

async function generateEPG() {
  console.log('Carregando canais...');
  const channels = await loadChannels();
  console.log(`Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  channels.forEach(channel => {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
  });

  const dates = getDates();

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);

      for (const program of programs) {
        const splitThreshold = new Date(program.start);
        splitThreshold.setUTCHours(3, 0, 0, 0);

        if (program.start < splitThreshold && program.end > splitThreshold) {
          // Programa cruza 03:00 - Dividir
          const firstPartEnd = new Date(splitThreshold);
          firstPartEnd.setUTCSeconds(firstPartEnd.getUTCSeconds() - 1);

          epgXml += `  <programme start="${formatDate(program.start)}" stop="${formatDate(firstPartEnd)}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Parte depois das 03:00 vai para o próximo dia
          const secondPartStart = new Date(splitThreshold);
          const secondPartEnd = new Date(program.end);

          epgXml += `  <programme start="${formatDate(secondPartStart)}" stop="${formatDate(secondPartEnd)}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
        } else {
          // Programa normal
          epgXml += `  <programme start="${formatDate(program.start)}" stop="${formatDate(program.end)}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
        }
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('✅ EPG gerado com sucesso em epg.xml');
}

generateEPG();
