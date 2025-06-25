const axios = require('axios');
const fs = require('fs');
const { parseStringPromise, Builder } = require('xml2js');
const cheerio = require('cheerio');

const CHANNELS_FILE = './channels.xml';
const OUTPUT_FILE = './epg.xml';
const BASE_URL = 'https://mi.tv/br/async/channel';

const FETCH_DAYS = [-1, 0, 1, 2]; // Ontem, hoje, amanhã, depois de amanhã

async function fetchChannelList() {
  const xmlData = fs.readFileSync(CHANNELS_FILE, 'utf-8');
  const parsed = await parseStringPromise(xmlData);
  return parsed.channels.channel.map(c => ({
    id: c.$.site_id.replace('br#', ''),
    xmltv_id: c.$.xmltv_id,
    name: c._
  }));
}

function getDates() {
  const today = new Date();
  return FETCH_DAYS.map(offset => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() + offset);
    return date.toISOString().split('T')[0];
  });
}

async function fetchEPGForChannel(channel) {
  const dates = getDates();
  let programmes = [];

  for (const date of dates) {
    const url = `${BASE_URL}/${channel.id}/${date}/0`;
    try {
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);

      $('.card-program').each((_, element) => {
        const startStr = $(element).attr('data-start');
        const endStr = $(element).attr('data-end');
        if (!startStr || !endStr) return;

        const startDate = new Date(startStr);
        const endDate = new Date(endStr);

        const splitThreshold = new Date(startDate);
        splitThreshold.setUTCHours(3, 0, 0, 0); // 03:00 GMT 0000

        const title = $(element).find('.program-title').text().trim() || 'Sem título';
        const desc = $(element).find('.program-description').text().trim() || '';

        if (startDate < splitThreshold && endDate > splitThreshold) {
          // O programa atravessa as 03:00 - deve ser dividido

          // Parte antes das 03:00
          const part1End = new Date(splitThreshold);
          programmes.push({
            $: {
              start: formatDate(startDate),
              stop: formatDate(part1End),
              channel: channel.xmltv_id
            },
            title: [{ _: title, $: { lang: 'pt' } }],
            desc: [{ _: desc, $: { lang: 'pt' } }]
          });

          // Parte depois das 03:00 (dia seguinte)
          const part2Start = new Date(splitThreshold);
          const part2End = endDate;

          programmes.push({
            $: {
              start: formatDate(part2Start),
              stop: formatDate(part2End),
              channel: channel.xmltv_id
            },
            title: [{ _: title, $: { lang: 'pt' } }],
            desc: [{ _: desc, $: { lang: 'pt' } }]
          });

        } else if (startDate >= splitThreshold) {
          // Programas que começam após 03:00 - atribuir para o dia seguinte
          const adjustedStart = new Date(startDate);
          const adjustedEnd = new Date(endDate);

          adjustedStart.setUTCDate(adjustedStart.getUTCDate() + 1);
          adjustedEnd.setUTCDate(adjustedEnd.getUTCDate() + 1);

          programmes.push({
            $: {
              start: formatDate(adjustedStart),
              stop: formatDate(adjustedEnd),
              channel: channel.xmltv_id
            },
            title: [{ _: title, $: { lang: 'pt' } }],
            desc: [{ _: desc, $: { lang: 'pt' } }]
          });
        } else {
          // Programa normal (não cruza 03:00)
          programmes.push({
            $: {
              start: formatDate(startDate),
              stop: formatDate(endDate),
              channel: channel.xmltv_id
            },
            title: [{ _: title, $: { lang: 'pt' } }],
            desc: [{ _: desc, $: { lang: 'pt' } }]
          });
        }
      });
    } catch (error) {
      console.error(`Erro ao buscar EPG para ${channel.name} no dia ${date}:`, error.message);
    }
  }

  return programmes;
}

function formatDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

async function generateEPG() {
  console.log('🔍 Buscando canais...');
  const channels = await fetchChannelList();
  let programmes = [];

  for (const channel of channels) {
    console.log(`📡 Buscando EPG de ${channel.name}...`);
    const channelProgrammes = await fetchEPGForChannel(channel);
    programmes.push(...channelProgrammes);
  }

  const epg = {
    tv: {
      $: {
        'source-info-name': 'mi.tv',
        'generator-info-name': 'EPG Generator',
        'generator-info-url': 'https://mi.tv'
      },
      channel: channels.map(c => ({
        $: { id: c.xmltv_id },
        'display-name': [{ _: c.name }]
      })),
      programme: programmes
    }
  };

  const builder = new Builder();
  const xml = builder.buildObject(epg);

  fs.writeFileSync(OUTPUT_FILE, xml);
  console.log('✅ EPG atualizado com sucesso!');
}

generateEPG();
