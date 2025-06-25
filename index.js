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

    // Organizar e calcular horários de término
    for (let i = 0; i < programs.length; i++) {
      const program = programs[i];
      const nextProgram = programs[i + 1];

      let endDate;

      if (nextProgram) {
        endDate = new Date(nextProgram.startDate);
      } else {
        // Último programa (duração padrão 90 min)
        endDate = new Date(program.startDate.getTime() + 90 * 60000);
      }

      program.start = formatDate(program.startDate);
      program.end = formatDate(endDate);
    }

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

  for (let i = -1; i <= 2; i++) {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates; // Ontem, hoje, amanhã e depois de amanhã
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

      for (const program of programs) {
        const startHour = parseInt(program.start.substr(8, 2));
        const programStartDate = new Date(program.start.substr(0, 4) + '-' + program.start.substr(4, 2) + '-' + program.start.substr(6, 2));
        const programEndDate = new Date(program.end.substr(0, 4) + '-' + program.end.substr(4, 2) + '-' + program.end.substr(6, 2));
        let finalStart = program.start;
        let finalEnd = program.end;

        // Adiciona 1 dia caso o programa comece a partir das 00:00
        if (startHour >= 0 && startHour < 3) {
          const newStart = new Date(new Date(programStartDate.getTime() + (24 * 60 * 60 * 1000)).toISOString().substr(0, 10) + program.start.substr(8));
          const newEnd = new Date(new Date(programEndDate.getTime() + (24 * 60 * 60 * 1000)).toISOString().substr(0, 10) + program.end.substr(8));

          finalStart = formatDate(newStart);
          finalEnd = formatDate(newEnd);
        }

        epgXml += `  <programme start="${finalStart}" stop="${finalEnd}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
