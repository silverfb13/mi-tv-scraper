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
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
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

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);
    let allPrograms = [];

    const dates = getDates();
    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    allPrograms.sort((a, b) => a.startDate - b.startDate);

    // Corrigir a duração e os horários sobrepostos
    for (let i = 0; i < allPrograms.length; i++) {
      let currentProgram = allPrograms[i];
      let nextProgram = allPrograms[i + 1];

      if (nextProgram) {
        currentProgram.endDate = new Date(nextProgram.startDate);
      } else {
        currentProgram.endDate = new Date(currentProgram.startDate.getTime() + 90 * 60000); // Assume 90 minutos no último
      }
    }

    // Aplicar as regras de 00:00 e 03:00
    const finalPrograms = [];
    const lastProgramStart = allPrograms[allPrograms.length - 1].startDate;

    for (let program of allPrograms) {
      const startHour = program.startDate.getUTCHours();
      let programDay = new Date(program.startDate);

      if (program.startDate < lastProgramStart) {
        if (program.startDate.getUTCHours() < 3 && program.startDate.getUTCHours() >= 0) {
          // Entre 00:00 e início do último programa: adicionar +1 dia no horário, mas manter no mesmo dia no XML
          program.startDate.setUTCDate(program.startDate.getUTCDate() + 1);
          program.endDate.setUTCDate(program.endDate.getUTCDate() + 1);
        }
      }

      if (program.startDate.getUTCHours() >= 3 && program.startDate < lastProgramStart) {
        // Entre 03:00 e início do último programa: mover para o dia seguinte no XML
        programDay.setUTCDate(programDay.getUTCDate() + 1);
      }

      // Dividir programas que atravessam 03:00
      const threeAM = new Date(program.startDate);
      threeAM.setUTCHours(3, 0, 0, 0);

      if (program.startDate < threeAM && program.endDate > threeAM) {
        // Parte antes das 03:00
        finalPrograms.push({
          start: formatDate(program.startDate),
          end: formatDate(threeAM),
          channel: channel.id,
          title: program.title,
          desc: program.desc,
          rating: program.rating
        });

        // Parte depois das 03:00 (mover para dia seguinte no XML)
        const nextDay = new Date(programDay);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);

        finalPrograms.push({
          start: formatDate(threeAM),
          end: formatDate(program.endDate),
          channel: channel.id,
          title: program.title,
          desc: program.desc,
          rating: program.rating
        });
      } else {
        finalPrograms.push({
          start: formatDate(program.startDate),
          end: formatDate(program.endDate),
          channel: channel.id,
          title: program.title,
          desc: program.desc,
          rating: program.rating
        });
      }
    }

    for (const program of finalPrograms) {
      epgXml += `  <programme start="${program.start} +0000" stop="${program.end} +0000" channel="${program.channel}">\n`;
      epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
      epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
      epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
      epgXml += `  </programme>\n`;
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
