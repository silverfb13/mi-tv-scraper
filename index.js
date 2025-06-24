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

// Função para corrigir horário e ajustar para UTC + formato EPG
function parseProgramTime(dateStr, timeStr) {
  // dateStr: "2025-06-23"
  // timeStr: "23:30"
  const [year, month, day] = dateStr.split('-').map(Number);
  let [hour, minute] = timeStr.split(':').map(Number);

  // Cria Date local do horário do programa
  let dateObj = new Date(year, month - 1, day, hour, minute, 0);

  // Ajusta para UTC somando 3h (porque o horário é UTC-3)
  dateObj = new Date(dateObj.getTime() + 3 * 60 * 60 * 1000);

  // Retorna string no formato yyyymmddHHMMSS +0000
  return formatDate(dateObj) + ' +0000';
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
        // Usa a função nova para o horário correto
        const start = parseProgramTime(date, time);

        // Para calcular o end, cria objeto Date a partir do start (UTC)
        const startDate = new Date(
          parseInt(start.substring(0,4)),
          parseInt(start.substring(4,6)) - 1,
          parseInt(start.substring(6,8)),
          parseInt(start.substring(8,10)),
          parseInt(start.substring(10,12)),
          parseInt(start.substring(12,14))
        );

        // Programa dura 90 minutos
        const endDate = new Date(startDate.getTime() + 90 * 60000);

        // Ajusta o end para string EPG (formato yyyymmddHHMMSS +0000)
        const end = formatDate(endDate) + ' +0000';

        programs.push({
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
  return date.toISOString().replace(/[-:]/g, '').split('.')[0];
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

      for (const program of programs) {
        epgXml += `  <programme start="${program.start}" stop="${program.end}" channel="${channel.id}">\n`;
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
