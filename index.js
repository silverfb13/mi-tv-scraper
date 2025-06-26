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
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const $ = load(response.data);
    const programs = [];

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`);
        const start = new Date(startDate);
        const end = new Date(startDate.getTime() + 90 * 60000);

        programs.push({
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
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

function getDates() {
  const dates = [];
  const now = new Date();
  const localTime = new Date(now.getTime() - (3 * 60 * 60 * 1000));

  for (let i = -1; i <= 2; i++) {
    const date = new Date(localTime);
    date.setDate(localTime.getDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates.slice(0, 4);
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
      if (programs.length === 0) continue;

      const lastProgramStart = programs[programs.length - 1].start;

      for (const program of programs) {
        const startHour = program.start.getHours();
        const startMinutes = program.start.getMinutes();

        // Se começar entre 00:00 e o início do último programa da lista, adicionar 1 dia no horário, mas manter no mesmo dia da programação
        if (program.start.getHours() >= 0 && program.start < lastProgramStart) {
          program.start.setDate(program.start.getDate() + 1);
          program.end.setDate(program.end.getDate() + 1);
        }

        // Se começar entre 03:00 e o início do último programa da lista, mover para o próximo dia da programação
        if (program.start.getHours() >= 3 && program.start < lastProgramStart) {
          const newDate = new Date(date);
          newDate.setDate(newDate.getDate() + 1);
          date = newDate.toISOString().split('T')[0];
        }

        // Dividir programa que atravessa 03:00
        const threeAM = new Date(program.start);
        threeAM.setHours(3, 0, 0, 0);

        if (program.start < threeAM && program.end > threeAM) {
          // Parte antes das 03:00
          epgXml += `  <programme start="${formatDate(program.start)} 0000" stop="${formatDate(threeAM)} 0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Parte depois das 03:00
          const newDate = new Date(date);
          newDate.setDate(newDate.getDate() + 1);
          const nextDate = newDate.toISOString().split('T')[0];

          epgXml += `  <programme start="${formatDate(threeAM)} 0000" stop="${formatDate(program.end)} 0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;
        } else {
          // Programa normal
          epgXml += `  <programme start="${formatDate(program.start)} 0000" stop="${formatDate(program.end)} 0000" channel="${channel.id}">\n`;
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
