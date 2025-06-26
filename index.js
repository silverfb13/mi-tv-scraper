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
        const start = `${formatDate(startDate)} +0000`;

        const endDate = new Date(startDate.getTime() + 90 * 60000);
        const end = `${formatDate(endDate)} +0000`;

        programs.push({
          startDate,
          endDate,
          start,
          end,
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

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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

      if (programs.length === 0) continue;

      const lastProgramStart = programs[programs.length - 1].startDate;

      for (const program of programs) {
        const programStartUTC = program.startDate;
        const programEndUTC = program.endDate;

        const programStartHour = programStartUTC.getUTCHours();
        const programEndHour = programEndUTC.getUTCHours();

        // Verificar se o programa cruza 03:00
        const threeUTC = new Date(programStartUTC);
        threeUTC.setUTCHours(3, 0, 0, 0);

        if (programStartUTC < threeUTC && programEndUTC > threeUTC) {
          // Regra 3 - Programa atravessa 03:00
          // Dividir o programa em duas partes

          // Parte 1 - Até 03:00 (mesmo dia)
          epgXml += `  <programme start="${formatDate(programStartUTC)} +0000" stop="${formatDate(threeUTC)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)} (Parte 1)</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

          // Parte 2 - Após 03:00 (dia seguinte)
          const nextDayStart = addDays(threeUTC, 1);
          const nextDayEnd = addDays(programEndUTC, 1);

          epgXml += `  <programme start="${formatDate(nextDayStart)} +0000" stop="${formatDate(nextDayEnd)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)} (Parte 2)</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

        } else if (programStartHour >= 0 && programStartHour < 3) {
          // Regra 1 - Entre 00:00 e 03:00 (mesmo dia)
          epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

        } else if (programStartUTC >= threeUTC && programStartUTC < lastProgramStart) {
          // Regra 2 - Entre 03:00 e início do último programa (dia seguinte)
          const newStart = addDays(programStartUTC, 1);
          const newEnd = addDays(programEndUTC, 1);

          epgXml += `  <programme start="${formatDate(newStart)} +0000" stop="${formatDate(newEnd)} +0000" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
          epgXml += `  </programme>\n`;

        } else {
          // Caso o programa não se encaixe nas regras (adicionar normal)
          epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
          epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
          epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
          epgXml += `    <rating system="Brazil">\n      <value>${program.rating}</value>\n    </rating>\n`;
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
