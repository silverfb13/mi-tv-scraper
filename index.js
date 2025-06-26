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

    // Captura dados do site
    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        // Cria objeto Date para o início do programa em GMT +0000
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);

        programs.push({
          startDate,
          title,
          desc: description || 'Sem descrição',
          rating: '[14]'
        });
      }
    });

    // Agora calcula o endDate de cada programa usando o startDate do próximo
    for (let i = 0; i < programs.length; i++) {
      if (i + 1 < programs.length) {
        // Duração até o próximo programa
        programs[i].endDate = new Date(programs[i + 1].startDate);
      } else {
        // Último programa do dia: assume duração padrão 90 min
        programs[i].endDate = new Date(programs[i].startDate.getTime() + 90 * 60000);
      }
    }

    return programs;

  } catch (error) {
    console.error(`Erro ao buscar ${url}: ${error.message}`);
    return [];
  }
}

// Função para formatar data no formato desejado sem "T"
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

// FUNÇÃO PRINCIPAL DAS 3 REGRAS
function ajustarProgramasComRegras(programas) {
  const programasAjustados = [];
  if (programas.length === 0) return programasAjustados;

  // 03:00 AM do dia do primeiro programa em UTC (GMT+0000)
  const diaReferencia = new Date(programas[0].startDate);
  diaReferencia.setUTCHours(3, 0, 0, 0);

  for (const prog of programas) {
    const start = prog.startDate;
    const end = prog.endDate;

    if (end <= diaReferencia) {
      // Programa termina antes das 3h -> fica no mesmo dia
      programasAjustados.push(prog);

    } else if (start >= diaReferencia) {
      // Programa começa após as 3h -> passa para o dia seguinte (+1 dia)
      const novoStart = new Date(start);
      const novoEnd = new Date(end);
      novoStart.setUTCDate(novoStart.getUTCDate() + 1);
      novoEnd.setUTCDate(novoEnd.getUTCDate() + 1);

      programasAjustados.push({
        ...prog,
        startDate: novoStart,
        endDate: novoEnd,
      });

    } else {
      // Programa atravessa 3h -> divide em dois programas

      // Parte 1: do início até 03:00
      programasAjustados.push({
        ...prog,
        startDate: start,
        endDate: diaReferencia,
      });

      // Parte 2: de 03:00 até o fim, no dia seguinte
      const novoStart = new Date(diaReferencia);
      const novoEnd = new Date(end);
      novoStart.setUTCDate(novoStart.getUTCDate() + 1);
      novoEnd.setUTCDate(novoEnd.getUTCDate() + 1);

      programasAjustados.push({
        ...prog,
        startDate: novoStart,
        endDate: novoEnd,
      });
    }
  }

  // Ordena para evitar sobreposição
  programasAjustados.sort((a, b) => a.startDate - b.startDate);

  return programasAjustados;
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

      // Aplica as regras
      const programasAjustados = ajustarProgramasComRegras(programs);

      for (const program of programasAjustados) {
        const start = formatDate(program.startDate) + ' +0000';
        const end = formatDate(program.endDate) + ' +0000';

        epgXml += `  <programme start="${start}" stop="${end}" channel="${channel.id}">\n`;
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
