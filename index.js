const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { parseStringPromise, Builder } = require('xml2js');

// Configurações
const CHANNELS_FILE = 'channels.xml';
const OUTPUT_FILE = 'epg.xml';

const BASE_URL = 'https://mi.tv/br/async/channel';
const TIME_SPLIT_HOUR = 3; // 03:00 AM (GMT+0000)

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getDatesToFetch() {
  const now = new Date();
  const dates = [];
  for (let i = -1; i <= 2; i++) { // Ontem, hoje, amanhã, depois de amanhã
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(formatDate(d));
  }
  return dates;
}

async function fetchChannelList() {
  const xmlData = fs.readFileSync(CHANNELS_FILE, 'utf-8');
  const parsed = await parseStringPromise(xmlData);
  return parsed.channels.channel.map(c => ({
    id: c.$.site_id.replace('br#', ''), // Remover o "br#"
    xmltv_id: c.$.xmltv_id,
    name: c._
  }));
}

function parseTime(rawTime, currentDate) {
  const [hour, minute] = rawTime.split(':').map(Number);
  const date = new Date(`${currentDate}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00Z`);
  return date.getTime();
}

async function fetchEPGForChannel(channel, dates) {
  const programmes = [];
  for (const date of dates) {
    try {
      const url = `${BASE_URL}/${channel.id}/${date}/0`;
      const response = await axios.get(url);
      const $ = cheerio.load(response.data);

      $('.schedule-program').each((_, el) => {
        const title = $(el).find('.program-title').text().trim();
        const desc = $(el).find('.program-description').text().trim();
        const time = $(el).find('.program-time').text().trim();
        const [startTime, endTime] = time.split(' - ').map(t => t.trim());

        if (!startTime || !endTime) return;

        const startTimestamp = parseTime(startTime, date);
        let endTimestamp = parseTime(endTime, date);
        if (endTimestamp <= startTimestamp) {
          endTimestamp += 24 * 3600 * 1000; // Correção caso o horário final seja no dia seguinte
        }

        // Aqui que entra a lógica da divisão após 03:00
        const splitTimestamp = new Date(`${date}T03:00:00Z`).getTime();

        if (startTimestamp >= splitTimestamp) {
          // Programação totalmente depois das 03:00 -> pertence ao dia seguinte
          const newDate = new Date(new Date(date).getTime() + 24 * 3600 * 1000);
          programmes.push({
            start: new Date(startTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            stop: new Date(endTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            channel: channel.xmltv_id,
            title,
            desc
          });
        } else if (endTimestamp > splitTimestamp) {
          // Programação que atravessa 03:00 -> divide o programa
          // Parte 1: até 03:00 no dia atual
          programmes.push({
            start: new Date(startTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            stop: new Date(splitTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            channel: channel.xmltv_id,
            title,
            desc
          });
          // Parte 2: de 03:00 até o fim no dia seguinte
          const newDate = new Date(new Date(date).getTime() + 24 * 3600 * 1000);
          programmes.push({
            start: new Date(splitTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            stop: new Date(endTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            channel: channel.xmltv_id,
            title,
            desc
          });
        } else {
          // Programação normal
          programmes.push({
            start: new Date(startTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            stop: new Date(endTimestamp).toISOString().replace(/[-:]/g, '').slice(0, 15) + ' +0000',
            channel: channel.xmltv_id,
            title,
            desc
          });
        }
      });
    } catch (err) {
      console.error(`Erro ao buscar ${channel.id} no dia ${date}: ${err.message}`);
    }
  }
  return programmes;
}

async function buildEPG() {
  const channels = await fetchChannelList();
  const dates = getDatesToFetch();

  const tv = {
    tv: {
      $: {
        "source-info-name": "mi.tv scraper",
        "generator-info-name": "custom-epg-generator"
      },
      channel: [],
      programme: []
    }
  };

  for (const channel of channels) {
    tv.tv.channel.push({
      $: { id: channel.xmltv_id },
      "display-name": channel.name
    });

    const epgData = await fetchEPGForChannel(channel, dates);
    epgData.forEach(program => {
      tv.tv.programme.push({
        $: {
          start: program.start,
          stop: program.stop,
          channel: program.channel
        },
        title: { _: program.title, $: { lang: "pt" } },
        desc: { _: program.desc, $: { lang: "pt" } }
      });
    });
  }

  const builder = new Builder();
  const xml = builder.buildObject(tv);
  fs.writeFileSync(OUTPUT_FILE, xml);
  console.log('EPG atualizado com sucesso!');
}

buildEPG();
