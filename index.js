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
        const startDate = new Date(`${date} ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`);
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
  return dates.slice(0, 4);
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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
      allPrograms.push(...programs);
    }

    allPrograms.sort((a, b) => a.startDate - b.startDate);

    const lastProgramStart = allPrograms[allPrograms.length - 1].startDate;

    for (let i = 0; i < allPrograms.length; i++) {
      const program = allPrograms[i];
      const nextProgram = allPrograms[i + 1];
      let endDate;

      if (nextProgram) {
        endDate = new Date(nextProgram.startDate);
      } else {
        endDate = new Date(program.startDate.getTime() + 90 * 60000);
      }

      let startDate = new Date(program.startDate);

      // Regra entre 00:00 e o início do último programa
      const isBetweenMidnightAndLast = startDate.getUTCHours() < 3 && startDate < lastProgramStart;

      if (isBetweenMidnightAndLast) {
        if (startDate.getUTCHours() >= 0 && startDate.getUTCHours() < 3) {
          const adjustedStartDate = new Date(startDate);
          adjustedStartDate.setUTCDate(adjustedStartDate.getUTCDate() + 1);

          const adjustedEndDate = new Date(endDate);
          adjustedEndDate.setUTCDate(adjustedEndDate.getUTCDate() + 1);

          startDate = adjustedStartDate;
          endDate = adjustedEndDate;
        }
      }

      // Dividir programa que atravessa 03:00
      const splitPoint = new Date(startDate);
      splitPoint.setUTCHours(3, 0, 0, 0);

      if (startDate < splitPoint && endDate > splitPoint) {
        // Primeira parte (até 03:00, dia original)
        epgXml += `  <programme start="${formatDate(startDate)}" stop="${formatDate(splitPoint)}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;

        // Segunda parte (após 03:00, mover para o dia seguinte no XML)
        const newStart = new Date(splitPoint);
        const newEnd = new Date(endDate);
        newStart.setUTCDate(newStart.getUTCDate() + 1);
        newEnd.setUTCDate(newEnd.getUTCDate() + 1);

        epgXml += `  <programme start="${formatDate(newStart)}" stop="${formatDate(newEnd)}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)} (Continuação)</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      } else if (startDate.getUTCHours() >= 3 && startDate < lastProgramStart) {
        // Programas após 03:00 → mudar o dia da programação
        startDate.setUTCDate(startDate.getUTCDate() + 1);
        endDate.setUTCDate(endDate.getUTCDate() + 1);

        epgXml += `  <programme start="${formatDate(startDate)}" stop="${formatDate(endDate)}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      } else {
        // Programas normais
        epgXml += `  <programme start="${formatDate(startDate)}" stop="${formatDate(endDate)}" channel="${channel.id}">\n`;
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
