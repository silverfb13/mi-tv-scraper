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
    let allPrograms = [];

    for (const date of getDates()) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    if (allPrograms.length === 0) continue;

    allPrograms.sort((a, b) => a.startDate - b.startDate);
    const lastProgramStart = allPrograms[allPrograms.length - 1].startDate;

    const finalPrograms = [];
    for (let i = 0; i < allPrograms.length; i++) {
      const current = allPrograms[i];
      const next = allPrograms[i + 1];

      let start = new Date(current.startDate);
      let stop;

      if (next) {
        stop = new Date(next.startDate);
      } else {
        stop = new Date(start.getTime() + 60 * 60000);
      }

      const hourUTC = start.getUTCHours();

      if (start > lastProgramStart) {
        // Já está no bloco pós-último programa
      } else if (hourUTC < 3) {
        if (start < lastProgramStart && start.getUTCHours() < 3) {
          // Entre 00:00 e 03:00 → Adiciona +1 dia no horário, mas mantém no mesmo dia no XML
          start.setUTCDate(start.getUTCDate() + 1);
          stop.setUTCDate(stop.getUTCDate() + 1);
        }
      } else if (start.getUTCHours() >= 3 && start < lastProgramStart) {
        // Mover para o dia seguinte no XML
        start.setUTCDate(start.getUTCDate() + 1);
        stop.setUTCDate(stop.getUTCDate() + 1);
      }

      // Dividir se atravessar 03:00
      if (start.getUTCHours() < 3 && stop.getUTCHours() >= 3) {
        const splitTime = new Date(start);
        splitTime.setUTCHours(3, 0, 0, 0);

        finalPrograms.push({
          start: formatDate(start) + ' +0000',
          stop: formatDate(splitTime) + ' +0000',
          title: current.title,
          desc: current.desc,
          rating: current.rating,
          channel: channel.id
        });

        start = new Date(splitTime);
      }

      finalPrograms.push({
        start: formatDate(start) + ' +0000',
        stop: formatDate(stop) + ' +0000',
        title: current.title,
        desc: current.desc,
        rating: current.rating,
        channel: channel.id
      });
    }

    finalPrograms.forEach(program => {
      epgXml += `  <programme start="${program.start}" stop="${program.stop}" channel="${program.channel}">\n`;
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
