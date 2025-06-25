import axios from 'axios';
import fs from 'fs/promises';
import { parseStringPromise, Builder } from 'xml2js';

// Função para formatar datas YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Pega datas de ontem, hoje, amanhã e depois de amanhã
function getDatesToFetch() {
  const dates = [];
  const now = new Date();
  for (let offset = -1; offset <= 2; offset++) {
    const d = new Date(now);
    d.setDate(now.getDate() + offset);
    dates.push(formatDate(d));
  }
  return dates;
}

// Lê e parseia channels.xml para extrair IDs e nomes
async function readChannels() {
  const xml = await fs.readFile('channels.xml', 'utf8');
  const result = await parseStringPromise(xml);
  // Esperando que o XML tenha <tv><channel> com id e display-name
  const channels = result.tv.channel.map(ch => ({
    id: ch.$.id,
    name: ch['display-name'][0] || ch.$['display-name'] || ch.$['name'] || 'Sem nome',
  }));
  return channels;
}

// Busca a programação de um canal para uma data
async function fetchSchedule(canalId, date) {
  const url = `https://mi.tv/br/async/channel/${canalId}/${date}/0`;
  try {
    const res = await axios.get(url);
    // Retorna array de programas (já com start, end, title, description)
    return res.data;
  } catch (error) {
    console.error(`Erro ao buscar programação para ${canalId} em ${date}:`, error.message);
    return [];
  }
}

// Monta o XML EPG
function buildXML(epgData) {
  const builder = new Builder({ headless: true, rootName: 'tv' });

  const tv = {
    $: { 'generator-info-name': 'mi-tv-scraper' },
    channel: [],
    programme: [],
  };

  for (const canal of epgData) {
    tv.channel.push({ $: { id: canal.id }, 'display-name': canal.name });

    for (const prog of canal.programs) {
      tv.programme.push({
        $: {
          start: prog.start, // formato: YYYYMMDDHHmmss +0000 (ex: 20250624153000 +0000)
          stop: prog.end,
          channel: canal.id,
        },
        title: { _: prog.title, $: { lang: 'pt' } },
        desc: { _: prog.description, $: { lang: 'pt' } },
      });
    }
  }

  return builder.buildObject(tv);
}

// Função principal que gera o EPG completo
async function generateEPG() {
  console.log('Lendo canais...');
  const channels = await readChannels();

  const dates = getDatesToFetch();
  console.log('Datas para buscar:', dates);

  const epgData = [];

  for (const canal of channels) {
    console.log(`Buscando programação do canal ${canal.id} (${canal.name})`);
    let allPrograms = [];

    for (const date of dates) {
      const progs = await fetchSchedule(canal.id, date);
      if (Array.isArray(progs)) {
        // Aqui você pode adaptar o formato do objeto conforme o que a API retorna
        // Exemplo de transformação para o padrão esperado:
        const mapped = progs.map(p => ({
          start: p.start.replace(' ', '') + ' +0000', // ajusta para formato XMLTV
          end: p.end.replace(' ', '') + ' +0000',
          title: p.title,
          description: p.description,
        }));
        allPrograms = allPrograms.concat(mapped);
      }
    }

    epgData.push({
      id: canal.id,
      name: canal.name,
      programs: allPrograms,
    });
  }

  console.log('Montando XML...');
  const xml = buildXML(epgData);

  console.log('Salvando epg.xml...');
  await fs.writeFile('epg.xml', xml, 'utf8');

  console.log('EPG atualizado com sucesso!');
}

generateEPG().catch(console.error);
