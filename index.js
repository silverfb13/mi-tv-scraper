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
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00-03:00`);
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

    let correctedPrograms = [];
    let lastEndDate = null;

    for (let i = 0; i < allPrograms.length; i++) {
      let program = allPrograms[i];
      let start = new Date(program.startDate);

      // Definir a duração como 90 minutos padrão
      let end = new Date(start.getTime() + 90 * 60000);

      // Se o horário do programa for entre 00:00 e o início do primeiro programa da lista
      if (start.getHours() < 3 && start < allPrograms[0].startDate) {
        start.setDate(start.getDate() + 1);
        end.setDate(end.getDate() + 1);
      }

      // Se o horário do programa for após 03:00 e antes do primeiro programa da lista -> mover para o próximo dia no XML
      let forceNextDay = false;
      if (start.getHours() >= 3 && start < allPrograms[0].startDate) {
        forceNextDay = true;
      }

      // Se o programa atravessa 03:00 -> dividir
      if (start.getHours() < 3 && end.getHours() >= 3) {
        let part1End = new Date(start);
        part1End.setHours(3, 0, 0, 0);

        let part2Start = new Date(part1End);

        // Parte antes de 03:00
        correctedPrograms.push({
          start: new Date(start),
          end: part1End,
          title: program.title,
          desc: program.desc,
          rating: program.rating,
          forceNextDay: false
        });

        // Parte depois de 03:00 (programação do dia seguinte)
        correctedPrograms.push({
          start: part2Start,
          end: new Date(end),
          title: program.title,
          desc: program.desc,
          rating: program.rating,
          forceNextDay: true
        });

        lastEndDate = new Date(end);
        continue;
      }

      // Programas contínuos
      if (lastEndDate && start < lastEndDate) {
        start = new Date(lastEndDate);
        end = new Date(start.getTime() + 90 * 60000);
      }

      correctedPrograms.push({
        start,
        end,
        title: program.title,
        desc: program.desc,
        rating: program.rating,
        forceNextDay
      });

      lastEndDate = new Date(end);
    }

    for (const program of correctedPrograms) {
      let startStr = formatDate(program.start);
      let endStr = formatDate(program.end);

      if (program.forceNextDay) {
        program.start.setDate(program.start.getDate() + 1);
        program.end.setDate(program.end.getDate() + 1);
        startStr = formatDate(program.start);
        endStr = formatDate(program.end);
      }

      epgXml += `  <programme start="${startStr} +0000" stop="${endStr} +0000" channel="${channel.id}">\n`;
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
