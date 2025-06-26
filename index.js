import axios from 'axios';
import { load } from 'cheerio';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

async function loadChannels() {
  const xml = await fs.readFile('channels.xml', 'utf-8');
  const result = await parseStringPromise(xml);
  return result.channels.channel.map(c => ({
    id: c._.trim(),
    site_id: c.$.site_id.replace('br#', '').trim()
  }));
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

async function fetchPrograms(channelId, date) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;
  try {
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = load(response.data);
    const programs = [];

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const desc = $(element).find('.synopsis').text().trim() || 'Sem descrição';

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);
        let startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00Z`);

        programs.push({ startDate, title, desc });
      }
    });

    return programs;
  } catch (error) {
    console.error(`Erro ao buscar ${url}: ${error.message}`);
    return [];
  }
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

    let allPrograms = [];
    const dates = getDates();

    for (const date of dates) {
      const programs = await fetchPrograms(channel.site_id, date);
      allPrograms = allPrograms.concat(programs);
    }

    // Ordem exata do site (como vem da mi.tv)
    allPrograms.sort((a, b) => a.startDate - b.startDate);

    const correctedPrograms = [];

    for (let i = 0; i < allPrograms.length; i++) {
      const current = allPrograms[i];
      const next = allPrograms[i + 1];

      let endDate = next ? new Date(next.startDate) : new Date(current.startDate.getTime() + 60 * 60 * 1000);

      const cutoff = new Date(current.startDate);
      cutoff.setUTCHours(3, 0, 0, 0);

      // Dividir programas que atravessam 03:00 GMT
      if (current.startDate < cutoff && endDate > cutoff) {
        correctedPrograms.push({
          start: formatDate(current.startDate),
          end: formatDate(cutoff),
          title: current.title,
          desc: current.desc
        });
        correctedPrograms.push({
          start: formatDate(cutoff),
          end: formatDate(endDate),
          title: current.title,
          desc: current.desc
        });
      } else if (current.startDate.getUTCHours() < 3 && current.startDate.getUTCHours() >= 0 && current.startDate.getUTCHours() < 3 && endDate.getUTCHours() < 3) {
        // Programas entre 00:00 e 03:00 permanecem no mesmo dia no XML, mas com +1 dia no horário
        const adjustedStart = new Date(current.startDate.getTime() + (24 * 60 * 60 * 1000));
        const adjustedEnd = new Date(endDate.getTime() + (24 * 60 * 60 * 1000));

        correctedPrograms.push({
          start: formatDate(adjustedStart),
          end: formatDate(adjustedEnd),
          title: current.title,
          desc: current.desc
        });
      } else {
        correctedPrograms.push({
          start: formatDate(current.startDate),
          end: formatDate(endDate),
          title: current.title,
          desc: current.desc
        });
      }
    }

    // Gerar XML
    for (const program of correctedPrograms) {
      epgXml += `  <programme start="${program.start} +0000" stop="${program.end} +0000" channel="${channel.id}">\n`;
      epgXml += `    <title lang="pt">${escapeXml(program.title)}</title>\n`;
      epgXml += `    <desc lang="pt">${escapeXml(program.desc)}</desc>\n`;
      epgXml += `    <rating system="Brazil">\n      <value>[14]</value>\n    </rating>\n`;
      epgXml += `  </programme>\n`;
    }
  }

  epgXml += '</tv>';

  await fs.writeFile('epg.xml', epgXml, 'utf-8');
  console.log('✅ EPG gerado com sucesso em epg.xml');
}

generateEPG();
