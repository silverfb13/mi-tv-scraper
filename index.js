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
        programs.push({
          startDate,
          time,
          title,
          desc: description || 'Sem descrição'
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

  return dates.slice(0, 4); // Ontem, hoje, amanhã e depois de amanhã
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
    let allPrograms = [];

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    allPrograms.sort((a, b) => a.startDate - b.startDate);

    const dayBlocks = {};

    // Organização por dia considerando regra das 00:00 e 03:00
    for (const program of allPrograms) {
      let displayDate = new Date(program.startDate);
      const hour = displayDate.getUTCHours();

      let dayKey = displayDate.toISOString().split('T')[0];

      if (hour < 3) {
        // Entre 00:00 e 03:00 -> adicionar +1 dia internamente (mas sem alterar XML)
        const adjustedDate = new Date(displayDate);
        adjustedDate.setUTCDate(adjustedDate.getUTCDate() + 1);
        dayKey = adjustedDate.toISOString().split('T')[0];
      }

      if (!dayBlocks[dayKey]) {
        dayBlocks[dayKey] = [];
      }

      dayBlocks[dayKey].push(program);
    }

    for (const day in dayBlocks) {
      const programs = dayBlocks[day];
      const lastProgramStart = programs[programs.length - 1].startDate;

      for (let i = 0; i < programs.length; i++) {
        const currentProgram = programs[i];
        const nextProgram = programs[i + 1];

        const start = new Date(currentProgram.startDate);
        const end = nextProgram ? new Date(nextProgram.startDate) : new Date(start.getTime() + 60 * 60000);

        let startString = formatDate(start);
        let endString = formatDate(end);

        // Verificar se cruza 03:00
        const crosses03 = (start.getUTCHours() < 3 && end.getUTCHours() >= 3);

        if (crosses03) {
          // Parte 1: início até 03:00
          const part1End = new Date(start);
          part1End.setUTCHours(3, 0, 0, 0);

          epgXml += `  <programme start="${formatDate(start)}" stop="${formatDate(part1End)}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(currentProgram.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(currentProgram.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Parte 2: 03:00 até o fim (adicionar +1 dia no XML)
          const part2Start = new Date(part1End);
          const part2End = end;

          const part2StartAdjusted = new Date(part2Start);
          part2StartAdjusted.setUTCDate(part2Start.getUTCDate() + 1);

          const part2EndAdjusted = new Date(part2End);
          part2EndAdjusted.setUTCDate(part2End.getUTCDate() + 1);

          epgXml += `  <programme start="${formatDate(part2StartAdjusted)}" stop="${formatDate(part2EndAdjusted)}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(currentProgram.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(currentProgram.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

        } else {
          if (start.getUTCHours() >= 3 && start < lastProgramStart) {
            // Programas entre 03:00 e o início do último programa → adicionar +1 dia no XML
            start.setUTCDate(start.getUTCDate() + 1);
            end.setUTCDate(end.getUTCDate() + 1);
            startString = formatDate(start);
            endString = formatDate(end);
          }

          epgXml += `  <programme start="${startString}" stop="${endString}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(currentProgram.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(currentProgram.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
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
