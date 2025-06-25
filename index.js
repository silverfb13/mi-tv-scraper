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
        const endDate = new Date(startDate.getTime() + 90 * 60000); // Assume 90 minutos padrão

        const splitThreshold = new Date(`${date}T03:00:00Z`);

        if (startDate < splitThreshold && endDate > splitThreshold) {
          // Programa cruza as 03:00 → Dividir

          // Parte 1 (antes das 03:00)
          programs.push({
            start: formatDate(startDate),
            end: formatDate(splitThreshold),
            title,
            desc: description || 'Sem descrição',
            rating: '[14]'
          });

          // Parte 2 (depois das 03:00) → Dia seguinte
          const nextDayStart = new Date(splitThreshold);
          const nextDayEnd = endDate;

          programs.push({
            start: formatDate(nextDayStart, true), // Força dia +1
            end: formatDate(nextDayEnd, true),
            title,
            desc: description || 'Sem descrição',
            rating: '[14]'
          });

        } else if (startDate >= splitThreshold) {
          // Programa começa depois de 03:00 → Joga para o dia seguinte
          programs.push({
            start: formatDate(startDate, true), // Dia +1
            end: formatDate(endDate, true),
            title,
            desc: description || 'Sem descrição',
            rating: '[14]'
          });

        } else {
          // Programa normal
          programs.push({
            start: formatDate(startDate),
            end: formatDate(endDate),
            title,
            desc: description || 'Sem descrição',
            rating: '[14]'
          });
        }
      }
    });

    return programs;

  } catch (error) {
    console.error(`Erro ao buscar ${url}: ${error.message}`);
    return [];
  }
}

function formatDate(date, forceNextDay = false) {
  const finalDate = new Date(date);
  if (forceNextDay) {
    finalDate.setUTCDate(finalDate.getUTCDate() + 1);
  }
  const year = finalDate.getUTCFullYear();
  const month = (finalDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = finalDate.getUTCDate().toString().padStart(2, '0');
  const hours = finalDate.getUTCHours().toString().padStart(2, '0');
  const minutes = finalDate.getUTCMinutes().toString().padStart(2, '0');
  const seconds = finalDate.getUTCSeconds().toString().padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds} +0000`;
}

function getDates() {
  const dates = [];
  const now = new Date();

  for (let i = -1; i <= 2; i++) {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates; // Ontem, hoje, amanhã, depois de amanhã
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&apos;');
}

async function generateEPG() {
  console.log('🔍 Carregando canais...');
  const channels = await loadChannels();

  console.log(`🔗 Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  channels.forEach(channel => {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${escapeXml(channel.id)}</display-name>\n  </channel>\n`;
  });

  for (const channel of channels) {
    console.log(`📡 Buscando EPG para ${channel.id}...`);

    const dates = getDates();
    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);

      for (const program of programs) {
        epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('✅ EPG gerado com sucesso!');
}

generateEPG();
