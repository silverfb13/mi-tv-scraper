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

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);
        const endDate = new Date(startDate.getTime() + 90 * 60000);

        programs.push({
          start: formatDate(startDate),
          end: formatDate(endDate),
          title,
          desc: description || 'Sem descrição',
          rating: '[14]',
          rawStart: startDate,
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
  // Formatar manualmente: YYYYMMDDHHMMSS +0000
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

  for (let i = -1; i <= 2; i++) { // Ontem, hoje, amanhã, depois de amanhã
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

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);

    let allPrograms = [];

    const dates = getDates();
    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    // Ordena os programas por horário
    allPrograms.sort((a, b) => a.rawStart - b.rawStart);

    if (allPrograms.length === 0) continue;

    const firstProgramTime = allPrograms[0].rawStart;

    allPrograms.forEach(program => {
      const startHour = program.rawStart.getUTCHours();

      // Adiciona 1 dia para programas entre 00:00 e o horário do primeiro programa
      if (program.rawStart.getUTCHours() < firstProgramTime.getUTCHours()) {
        program.rawStart.setUTCDate(program.rawStart.getUTCDate() + 1);
        const newEnd = new Date(program.rawStart.getTime() + 90 * 60000);
        program.start = formatDate(program.rawStart);
        program.end = formatDate(newEnd);
      }

      // Move para o dia seguinte se começar após as 03:00 UTC
      if (startHour >= 3) {
        program.rawStart.setUTCDate(program.rawStart.getUTCDate() + 1);
        const newEnd = new Date(program.rawStart.getTime() + 90 * 60000);
        program.start = formatDate(program.rawStart);
        program.end = formatDate(newEnd);
      }

      epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
      epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
      epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
      epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
      epgXml += `  </programme>\n`;
    });
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
