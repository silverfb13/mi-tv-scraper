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
        const endDate = new Date(startDate.getTime() + 90 * 60000);

        programs.push({
          startDate,
          endDate,
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
    let allPrograms = [];

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      programs.forEach(p => p.sourceDate = date);
      allPrograms = allPrograms.concat(programs);
    }

    allPrograms.sort((a, b) => a.startDate - b.startDate);

    if (allPrograms.length === 0) continue;

    const firstProgram = allPrograms[0];
    const firstProgramHour = firstProgram.startDate.getUTCHours();

    for (let program of allPrograms) {
      let startDate = program.startDate;
      let endDate = program.endDate;

      const programHour = startDate.getUTCHours();

      // Adicionar +1 dia no horário (somente entre 00:00 e o início do primeiro programa)
      if (programHour < firstProgramHour && programHour >= 0) {
        startDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
        endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
      }

      // Mover para o dia seguinte no XML (somente entre 03:00 e o início do primeiro programa)
      let channelId = channel.id;
      if (programHour >= 3 && programHour < firstProgramHour) {
        const originalDate = new Date(program.sourceDate + 'T00:00:00Z');
        originalDate.setUTCDate(originalDate.getUTCDate() + 1);
        const newDateString = originalDate.toISOString().split('T')[0];
        channelId = channel.id; // Mantemos o canal igual, só mudamos o dia no start
        startDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
        endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
      }

      epgXml += `  <programme start="${formatDate(startDate)} +0000" stop="${formatDate(endDate)} +0000" channel="${channelId}">\n`;
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
