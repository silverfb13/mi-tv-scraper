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
    let allPrograms = [];

    for (const date of dates) {
      const programs = await fetchChannelPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    allPrograms.sort((a, b) => a.startDate - b.startDate);

    for (let i = 0; i < allPrograms.length; i++) {
      const currentProgram = allPrograms[i];
      const nextProgram = allPrograms[i + 1] || allPrograms[0]; // Quando for o último, usa o primeiro do próximo dia

      let start = new Date(currentProgram.startDate);
      let end = new Date(nextProgram.startDate);

      const startHour = start.getUTCHours();
      const endHour = end.getUTCHours();

      // Verifica se cruza as 03:00
      if (startHour < 3 && endHour >= 3 && (start.toISOString().split('T')[0] === end.toISOString().split('T')[0])) {
        // Dividir o programa em duas partes
        const part1End = new Date(start);
        part1End.setUTCHours(3, 0, 0, 0);

        // Parte 1: sem mudar o dia no XML
        epgXml += `  <programme start="${formatDate(start)}" stop="${formatDate(part1End)}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(currentProgram.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(currentProgram.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;

        // Parte 2: acrescenta 1 dia no XML
        const part2Start = new Date(part1End);
        const part2End = new Date(end);

        part2Start.setUTCDate(part2Start.getUTCDate() + 1);
        part2End.setUTCDate(part2End.getUTCDate() + 1);

        epgXml += `  <programme start="${formatDate(part2Start)}" stop="${formatDate(part2End)}" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(currentProgram.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(currentProgram.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n`;
        epgXml += `  </programme>\n`;

      } else {
        let startString = formatDate(start);
        let endString = formatDate(end);

        if (startHour < 3) {
          // Entre 00:00 e 03:00: adianta 1 dia no código, mas mantém no XML
          const adjust = new Date(start);
          adjust.setUTCDate(adjust.getUTCDate() + 1);
        } else if (startHour >= 3 && startHour < 24 && start.getTime() < allPrograms[allPrograms.length - 1].startDate.getTime()) {
          // Entre 03:00 e o início do último programa → acrescenta 1 dia no XML
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

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
