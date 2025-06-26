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
  return dates.slice(0, 4);
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
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = load(response.data);
    const programs = [];

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`);
        programs.push({
          start: startDate,
          title,
          desc: description || 'Sem descrição',
          rating: '[14]'
        });
      }
    });

    programs.sort((a, b) => a.start - b.start);

    for (let i = 0; i < programs.length; i++) {
      if (i < programs.length - 1) {
        programs[i].end = programs[i + 1].start;
      } else {
        programs[i].end = new Date(programs[i].start.getTime() + 90 * 60000);
      }
    }

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

    for (const date of dates) {
      let programs = await fetchChannelPrograms(channel.site_id, date);
      if (programs.length === 0) continue;

      const firstProgramTime = programs[0].start;
      const threeAM = new Date(firstProgramTime);
      threeAM.setHours(3, 0, 0, 0);

      const updatedPrograms = [];

      for (let i = 0; i < programs.length; i++) {
        const prog = programs[i];

        const start = new Date(prog.start);
        const end = new Date(prog.end);

        // Programas que atravessam as 03:00
        if (start < threeAM && end > threeAM) {
          // Parte antes das 03:00
          updatedPrograms.push({
            start,
            end: threeAM,
            title: prog.title,
            desc: prog.desc,
            rating: prog.rating,
            forceDate: date
          });
          // Parte depois das 03:00 (no próximo dia)
          updatedPrograms.push({
            start: threeAM,
            end,
            title: prog.title,
            desc: prog.desc,
            rating: prog.rating,
            forceDate: getNextDate(date)
          });
        }
        // Programas entre 00:00 e início do primeiro programa
        else if (start.getHours() < 3 && start < firstProgramTime) {
          const newStart = new Date(start.getTime() + 24 * 60 * 60 * 1000);
          const newEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
          updatedPrograms.push({
            start: newStart,
            end: newEnd,
            title: prog.title,
            desc: prog.desc,
            rating: prog.rating,
            forceDate: date
          });
        }
        // Programas após as 03:00 -> mudar para o próximo dia
        else if (start >= threeAM && start < firstProgramTime) {
          updatedPrograms.push({
            start,
            end,
            title: prog.title,
            desc: prog.desc,
            rating: prog.rating,
            forceDate: getNextDate(date)
          });
        }
        // Programas normais
        else {
          updatedPrograms.push({
            start,
            end,
            title: prog.title,
            desc: prog.desc,
            rating: prog.rating,
            forceDate: date
          });
        }
      }

      for (const program of updatedPrograms) {
        epgXml += `  <programme start="${formatDate(program.start)} +0000" stop="${formatDate(program.end)} +0000" channel="${channel.id}">\n`;
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

function getNextDate(date) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

generateEPG();
