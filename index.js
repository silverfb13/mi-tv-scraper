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
  // Formata para "YYYYMMDD HHMMSS +0000" sem 'T'
  // ISO é UTC, já bom para GMT+0000
  return date.toISOString().replace('T', ' ').replace(/[-:]/g, '').split('.')[0] + ' +0000';
}

function escapeXml(unsafe) {
  return unsafe.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&apos;');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function startOfDayUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function fetchChannelPrograms(channelId, dateStr) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${dateStr}/0`;
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
        // Cria o startDate em UTC (GMT+0000)
        const startDate = new Date(`${dateStr}T${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:00Z`);

        // Duracao fixa de 90 minutos (podemos melhorar depois se precisar)
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

// Aplicar as 3 regras de ajuste do EPG (regra 1, 2 e 3)
function aplicarRegras(programsDiaX, programsDiaXmais1) {
  const resultado = [];

  // Ordena programas por horário inicial
  programsDiaX.sort((a,b) => a.startDate - b.startDate);
  if (programsDiaXmais1) programsDiaXmais1.sort((a,b) => a.startDate - b.startDate);

  const ultimoProgramaDiaX = programsDiaX[programsDiaX.length - 1];
  const primeiroProgramaDiaXmais1 = programsDiaXmais1 ? programsDiaXmais1[0] : null;

  // Limite para considerar o último horário do dia X
  const limiteFim = primeiroProgramaDiaXmais1
    ? primeiroProgramaDiaXmais1.startDate
    : (ultimoProgramaDiaX ? ultimoProgramaDiaX.endDate : null);

  for (const prog of programsDiaX) {
    const startH = prog.startDate.getUTCHours();
    const endH = prog.endDate.getUTCHours();

    const tresAM = new Date(prog.startDate);
    tresAM.setUTCHours(3,0,0,0);

    // Regra 3: programa atravessa 03:00 (começa antes e termina depois)
    if (prog.startDate < tresAM && prog.endDate > tresAM) {
      // Parte 1: até 03:00 do dia X
      const parte1 = {
        ...prog,
        endDate: tresAM
      };

      // Parte 2: após 03:00, deslocado para o dia seguinte
      const parte2 = {
        ...prog,
        startDate: tresAM,
        endDate: new Date(prog.endDate.getTime() + 24*3600*1000)
      };

      resultado.push(parte1);
      resultado.push(parte2);
      continue;
    }

    // Regra 1: programas entre 00:00 e 03:00 ficam no dia X
    if (startH >= 0 && startH < 3) {
      resultado.push(prog);
      continue;
    }

    // Regra 2: programas entre 03:00 e limiteFim vão para o dia seguinte
    if (startH >= 3 && limiteFim && prog.startDate < limiteFim) {
      const deslocado = {
        ...prog,
        startDate: new Date(prog.startDate.getTime() + 24*3600*1000),
        endDate: new Date(prog.endDate.getTime() + 24*3600*1000),
      };
      resultado.push(deslocado);
      continue;
    }

    // Caso padrão - fica no mesmo dia
    resultado.push(prog);
  }

  return resultado;
}

function formatForXML(prog, channelId) {
  return `  <programme start="${formatDate(prog.startDate)}" stop="${formatDate(prog.endDate)}" channel="${channelId}">
    <title lang="pt">${escapeXml(prog.title)}</title>
    <desc lang="pt">${escapeXml(prog.desc)}</desc>
    <rating system="Brazil">
      <value>${prog.rating}</value>
    </rating>
  </programme>
`;
}

function getDates() {
  const dates = [];
  const today = new Date();

  for (let i = -1; i <= 2; i++) {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + i);
    dates.push(date.toISOString().split('T')[0]);
  }

  return dates;
}

async function generateEPG() {
  console.log('Carregando canais...');
  const channels = await loadChannels();

  console.log(`Total de canais encontrados: ${channels.length}`);

  let epgXml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';

  for (const channel of channels) {
    epgXml += `  <channel id="${channel.id}">\n    <display-name lang="pt">${channel.id}</display-name>\n  </channel>\n`;
  }

  for (const channel of channels) {
    console.log(`Buscando EPG para ${channel.id}...`);

    const dates = getDates();

    // Buscar programas 2 em 2 para aplicar regra que olha dia X+1
    for (let i = 0; i < dates.length - 1; i++) {
      const diaX = dates[i];
      const diaXmais1 = dates[i+1];

      const programsDiaX = await fetchChannelPrograms(channel.site_id, diaX);
      const programsDiaXmais1 = await fetchChannelPrograms(channel.site_id, diaXmais1);

      const programsCorrigidos = aplicarRegras(programsDiaX, programsDiaXmais1);

      for (const prog of programsCorrigidos) {
        epgXml += formatForXML(prog, channel.id);
      }
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('EPG gerado com sucesso em epg.xml');
}

generateEPG();
