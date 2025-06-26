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
          start: startDate,
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
  return date.toISOString().replace('T', ' ').replace(/[-:]/g, '').split('.')[0];
}

function getDates() {
  const dates = [];
  const today = new Date();

  for (let i = -1; i <= 2; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
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

function aplicarRegras(programs) {
  if (programs.length === 0) return [];

  const adjustedPrograms = [];
  const firstProgramTime = programs[0].start.getUTCHours() * 100 + programs[0].start.getUTCMinutes();

  for (let i = 0; i < programs.length; i++) {
    let program = programs[i];
    let startHour = program.start.getUTCHours();
    let startMinutes = program.start.getUTCMinutes();
    let startTime = startHour * 100 + startMinutes;

    // Regra 1: Entre 00:00 e 03:00
    if (startHour >= 0 && startHour < 3) {
      program.start = new Date(program.start.getTime() + (24 * 60 * 60 * 1000));
    }
    // Regra 2: Entre 03:00 e início do primeiro programa do dia
    else if (startHour >= 3 && startTime < firstProgramTime) {
      program.start = new Date(program.start.getTime() + (24 * 60 * 60 * 1000));
    }

    adjustedPrograms.push(program);
  }

  return adjustedPrograms;
}

function atribuirHorariosFinais(programs) {
  const completedPrograms = [];

  for (let i = 0; i < programs.length; i++) {
    const current = programs[i];
    const next = programs[i + 1];

    let end;

    if (next) {
      end = new Date(next.start);
    } else {
      // Se for o último programa, adiciona 1 hora fictícia
      end = new Date(current.start.getTime() + 60 * 60000);
    }

    completedPrograms.push({
      start: formatDate(current.start),
      end: formatDate(end),
      title: current.title,
      desc: current.desc,
      rating: current.rating
    });
  }

  return completedPrograms;
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
      let programs = await fetchChannelPrograms(channel.site_id, date);
      programs = aplicarRegras(programs);
      programs = atribuirHorariosFinais(programs);

      for (const program of programs) {
        epgXml += `  <programme start="${program.start} +0000" stop="${program.end} +0000" channel="${channel.id}">\n`;
        epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
        epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
        epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
        epgXml += `  </programme>\n`;
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('✅ EPG gerado com sucesso em epg.xml');
}

generateEPG();
