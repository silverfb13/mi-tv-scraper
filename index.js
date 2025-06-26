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
        programs.push({
          startDate,
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

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');
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
  console.log('Carregando canais...');
  const channels = await loadChannels();

  console.log(`Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  channels.forEach(channel => {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
  });

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);

    const dates = getDates();
    const allPrograms = [];

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms.push({ date, programs });
    }

    // Montar EPG com horários de término corretos
    for (let dayIndex = 0; dayIndex < allPrograms.length; dayIndex++) {
      const { date, programs } = allPrograms[dayIndex];
      if (programs.length === 0) continue;

      let nextDayPrograms = [];
      if (dayIndex + 1 < allPrograms.length) {
        nextDayPrograms = allPrograms[dayIndex + 1].programs;
      }

      for (let i = 0; i < programs.length; i++) {
        const current = programs[i];
        let next;

        if (i < programs.length - 1) {
          next = programs[i + 1];
        } else if (nextDayPrograms.length > 0) {
          next = nextDayPrograms[0]; // O próximo é o primeiro programa do dia seguinte
        } else {
          next = { startDate: new Date(current.startDate.getTime() + 90 * 60000) };
        }

        let startDate = new Date(current.startDate);
        let endDate = new Date(next.startDate);

        // Regras do 00:00 e 03:00
        const startHour = startDate.getUTCHours();

        if (startHour >= 0 && startHour < 3) {
          // Entre 00:00 e 03:00 -> adiciona +1 dia no horário, mas NÃO muda o dia no XML
          startDate.setUTCDate(startDate.getUTCDate() + 1);
          endDate.setUTCDate(endDate.getUTCDate() + 1);
        } else if (startHour >= 3 && nextDayPrograms.length > 0 && startDate < nextDayPrograms[0].startDate) {
          // Entre 03:00 e início do primeiro programa do dia seguinte -> muda o programa para o dia seguinte
          // Ajusta a data base do programa para o dia seguinte no XML (só no XML)
          startDate.setUTCDate(startDate.getUTCDate() + 1);
          endDate.setUTCDate(endDate.getUTCDate() + 1);
        }

        const start = formatDate(startDate);
        const end = formatDate(endDate);

        epgXml += `  <programme start="${start}" stop="${end}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(current.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(current.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${current.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
