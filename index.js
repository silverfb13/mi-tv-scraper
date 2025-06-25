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
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

function getTargetDates() {
  const dates = [];
  const now = new Date();
  const baseDate = new Date(now.getTime() - (3 * 60 * 60 * 1000)); // Ajuste GMT -3

  for (let i = -2; i <= 3; i++) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + i);
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

async function fetchChannelPrograms(channelId, date) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = load(response.data);
    const programs = [];

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim() || 'Sem descrição';

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);

        let startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);

        // 🔥 Ajuste correto: se o horário for >= 03:00 GMT 0000, ADICIONA UM DIA (ajuste interno, NÃO altera o link)
        if (startDate.getUTCHours() >= 3) {
          startDate.setUTCDate(startDate.getUTCDate() + 1);
        }

        programs.push({
          start: new Date(startDate),
          title,
          desc: description
        });
      }
    });

    // Definir fim de cada programa baseado no início do próximo
    for (let i = 0; i < programs.length; i++) {
      const start = programs[i].start;
      const end = (i + 1 < programs.length) ? programs[i + 1].start : new Date(start.getTime() + 90 * 60000);
      programs[i].end = end;
    }

    return programs;
  } catch (error) {
    console.error(`Erro ao buscar ${url}: ${error.message}`);
    return [];
  }
}

async function generateEPG() {
  console.log('🔍 Carregando canais...');
  const channels = await loadChannels();
  console.log(`📺 Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  channels.forEach(channel => {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
  });

  const dates = getTargetDates();

  for (const channel of channels) {
    console.log(`🔄 Buscando EPG para ${channel.id}...`);

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);

      for (const program of programs) {
        const start = formatDate(program.start) + ' +0000';
        const end = formatDate(program.end) + ' +0000';

        epgXml += `  <programme start="${start}" stop="${end}" channel="${channel.id}">\n`;
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
