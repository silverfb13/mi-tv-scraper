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

    $('li').each((index, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);
        const start = `${formatDate(startDate)} +0000`;

        let endDate;
        const nextElement = $('li').eq(index + 1);
        if (nextElement.length) {
          const nextTime = nextElement.find('.time').text().trim();
          if (nextTime) {
            const [nextHours, nextMinutes] = nextTime.split(':').map(Number);
            endDate = new Date(`${date}T${nextHours.toString().padStart(2, '0')}:${nextMinutes.toString().padStart(2, '0')}:00Z`);
            if (endDate <= startDate) {
              endDate.setDate(endDate.getDate() + 1);
            }
          }
        }

        if (!endDate) {
          endDate = new Date(startDate.getTime() + 90 * 60000); // Último programa: 90 min
        }

        const end = `${formatDate(endDate)} +0000`;

        programs.push({
          startDate,
          endDate,
          start,
          end,
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
  return date.toISOString().replace('T', ' ').replace(/[-:]/g, '').split('.')[0];
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
    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);

      for (let i = 0; i < programs.length; i++) {
        let program = programs[i];
        const startHour = program.startDate.getUTCHours();
        const endHour = program.endDate.getUTCHours();

        // Regra 3: Dividir programas que passam por cima das 03:00
        if (program.startDate.getUTCHours() < 3 && program.endDate.getUTCHours() >= 3) {
          // Parte 1 - até 03:00
          const part1EndDate = new Date(program.startDate);
          part1EndDate.setUTCHours(3, 0, 0, 0);

          epgXml += `  <programme start="${program.start}" stop="${formatDate(part1EndDate)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Parte 2 - após 03:00
          const part2StartDate = new Date(part1EndDate);
          const part2EndDate = new Date(program.endDate);
          part2StartDate.setSeconds(part2StartDate.getSeconds() + 1);

          epgXml += `  <programme start="${formatDate(part2StartDate)} +0000" stop="${program.end}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
          continue;
        }

        // Regra 1: Entre 00:00 e 03:00 permanece no dia atual
        if (startHour >= 0 && startHour < 3) {
          epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
          continue;
        }

        // Regra 2: Programas que começam entre 03:00 e o último programa do dia
        if (startHour >= 3) {
          const newStartDate = new Date(program.startDate);
          const newEndDate = new Date(program.endDate);

          newStartDate.setUTCDate(newStartDate.getUTCDate() + 1);
          newEndDate.setUTCDate(newEndDate.getUTCDate() + 1);

          epgXml += `  <programme start="${formatDate(newStartDate)} +0000" stop="${formatDate(newEndDate)} +0000" channel="${channel.id}">\n`;
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
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
