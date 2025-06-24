import axios from 'axios';
import { load } from 'cheerio';
import fs from 'fs/promises';
import { parseStringPromise } from 'xml2js';
import dayjs from 'dayjs';

async function loadChannels() {
  const xml = await fs.readFile('channels.xml', 'utf-8');
  const result = await parseStringPromise(xml);
  return result.channels.channel.map(c => ({
    id: c._.trim(),
    site_id: c.$.site_id.replace('br#', '').trim(),
    source: c.$.source || 'mi' // Se quiser separar por origem
  }));
}

async function fetchMiTvPrograms(channelId, date) {
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
        const startDate = new Date(`${date} ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`);
        const start = `${formatDate(startDate)} -0300`;

        const endDate = new Date(startDate.getTime() + 90 * 60000);
        const end = `${formatDate(endDate)} -0300`;

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

async function fetchVivoPlayPrograms(channelId, date) {
  const starttime = Math.floor(date.getTime() / 1000);
  const endtime = Math.floor(new Date(date.getTime() + 24 * 60 * 60 * 1000).getTime() / 1000);

  const url = `https://contentapi-br.cdn.telefonica.com/25/default/pt-BR/schedules?ca_deviceTypes=null%7C401&ca_channelmaps=779%7Cnull&fields=Pid,Title,Description,ChannelName,ChannelNumber,CallLetter,Start,End,LiveChannelPid,LiveProgramPid,EpgSerieId,SeriesPid,SeriesId,SeasonPid,SeasonNumber,EpisodeNumber,images.videoFrame,images.banner,LiveToVod,AgeRatingPid,forbiddenTechnology,IsSoDisabled&includeRelations=Genre&orderBy=START_TIME%3Aa&filteravailability=false&includeAttributes=ca_cpvrDisable,ca_descriptors,ca_blackout_target,ca_blackout_areas&starttime=${starttime}&endtime=${endtime}&livechannelpids=${channelId}&offset=0&limit=1000`;

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const data = response.data.Content || [];
    const programs = [];

    data.forEach(item => {
      const startDate = new Date(item.Start * 1000);
      const endDate = new Date(item.End * 1000);

      programs.push({
        start: `${formatDate(startDate)} -0300`,
        end: `${formatDate(endDate)} -0300`,
        title: item.Title || 'Sem título',
        desc: item.Description || 'Sem descrição',
        rating: '[14]'
      });
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
    dates.push(date);
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
      let programs = [];

      if (channel.source === 'vivo') {
        programs = await fetchVivoPlayPrograms(channel.site_id, date);
      } else {
        programs = await fetchMiTvPrograms(channel.site_id, date.toISOString().split('T')[0]);
      }

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
