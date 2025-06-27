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
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
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

function atribuirHorariosFinais(programs) {
  const completedPrograms = [];

  for (let i = 0; i < programs.length; i++) {
    const current = programs[i];
    const next = programs[i + 1];

    let end;

    if (next) {
      end = new Date(next.start);
    } else {
      // Se não tem próximo, programa dura 1 hora
      end = new Date(current.start.getTime() + 60 * 60000);
    }

    completedPrograms.push({
      start: current.start,
      end,
      title: current.title,
      desc: current.desc,
      rating: current.rating
    });
  }

  return completedPrograms;
}

// NOVA FUNÇÃO que aplica a regra 2 modificada:
// Move programas entre 00:00 e início do último programa para o dia seguinte
function ajustarProgramasParaDiaSeguinte(programs) {
  if (programs.length === 0) return programs;

  // Encontra o horário do início do último programa do dia (menor horário entre os programas?)
  // Na verdade, pelo que você quer, o "início do último programa" é o horário do último programa em horário UTC (mais tarde)
  // O "início do último programa" significa o horário do programa com o horário maior

  // Ordena programas pelo horário de início só pra garantir
  programs.sort((a, b) => a.start - b.start);

  const lastProgramStart = programs[programs.length - 1].start;

  return programs.map(p => {
    const startUTC = p.start;
    // Hora do início do programa em horas e minutos
    // Queremos mover TODOS os programas que começam entre 00:00 e lastProgramStart para o dia seguinte.
    // Como lastProgramStart pode ser 23:xx, a regra será quase todos os programas do dia (a menos que o último programa seja meia-noite, aí não mexe)

    // Como a data do programa já tem dia e hora, vamos comparar hora: se o start é >= 00:00 do dia e < lastProgramStart, move para dia seguinte.
    // Só precisa garantir que o start do programa é no mesmo dia (pois programas podem ser de dias diferentes dependendo do carregamento)

    // Então: Se startUTC >= 00:00 do dia (sempre true) e startUTC < lastProgramStart -> add +1 dia

    if (startUTC < lastProgramStart) {
      // Move para o dia seguinte somando +1 dia
      const newStart = new Date(startUTC.getTime() + 24 * 3600 * 1000);
      const newEnd = new Date(p.end.getTime() + 24 * 3600 * 1000);

      return {
        ...p,
        start: newStart,
        end: newEnd
      };
    } else {
      // Mantém o programa
      return p;
    }
  });
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
      programs = atribuirHorariosFinais(programs);

      // Aqui aplica a regra nova que você pediu:
      programs = ajustarProgramasParaDiaSeguinte(programs);

      for (const program of programs) {
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
  console.log('✅ EPG gerado com sucesso em epg.xml');
}

generateEPG();
