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
        const startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`); // GMT +0000
        // O fim do programa vai ser ajustado no final, por enquanto só pega a duração padrão de 90 min
        // Mas vamos usar a regra para ajustar depois
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

// Formatar sem o "T"
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

// Função que ajusta horários segundo as regras:
// 1) Se programa começar depois das 03:00 UTC, joga para o próximo dia (ajustando start e end)
// 2) Se programa começar antes das 03:00 e terminar depois, mantém no mesmo dia (sem dividir)
// 3) Se end <= start (programa passa da meia-noite), ajusta end para dia seguinte
function ajustarHorarioPrograma(programa) {
  const corte3h = new Date(programa.startDate);
  corte3h.setUTCHours(3, 0, 0, 0); // 03:00 do mesmo dia

  let start = new Date(programa.startDate);
  let end = new Date(programa.endDate);

  // Ajusta programa que passa da meia-noite
  if (end <= start) {
    end.setUTCDate(end.getUTCDate() + 1);
  }

  // Se programa começa depois ou exatamente às 03:00, joga para o próximo dia
  if (start >= corte3h) {
    start.setUTCDate(start.getUTCDate() + 1);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
  }

  // Se programa começa antes das 03:00 e termina depois das 03:00, mantém sem dividir
  if (start < corte3h && end > corte3h) {
    return { start, end };
  }

  // Caso contrário, mantém os horários originais
  return { start, end };
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
        // Ajusta horário conforme regra
        const { start, end } = ajustarHorarioPrograma(program);

        const startStr = formatDate(start) + ' +0000';
        const endStr = formatDate(end) + ' +0000';

        epgXml += `  <programme start="${startStr}" stop="${endStr}" channel="${channel.id}">\n`;
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
