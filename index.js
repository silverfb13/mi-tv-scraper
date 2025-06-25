import axios from 'axios';
import { parseStringPromise, Builder } from 'xml2js';

async function fetchEPGChannel(channelId, date) {
  // date no formato YYYY-MM-DD (GMT 0)
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;
  try {
    const { data } = await axios.get(url);
    return data; // já é JSON
  } catch (err) {
    console.error(`Erro ao buscar canal ${channelId} data ${date}:`, err.message);
    return null;
  }
}

function buildXML(epgData) {
  const builder = new Builder({ headless: true, rootName: 'tv' });

  // Exemplo simples de estrutura (adaptar conforme sua necessidade)
  const tv = {
    $: { 'generator-info-name': 'mi-tv-scraper' },
    channel: [],
    programme: [],
  };

  for (const canal of epgData) {
    // canal.programas é array dos programas, canal.id o id do canal
    tv.channel.push({ $: { id: canal.id }, display-name: canal.name });

    for (const prog of canal.programs) {
      tv.programme.push({
        $: {
          start: prog.start, // em formato XMLTV (ex: 20250624150000 +0000)
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

async function main() {
  // Exemplo: canais e datas fixos só pra testar
  const canais = ['sportv-hd', 'espn1']; // exemplo
  const datas = ['2025-06-23', '2025-06-24', '2025-06-25', '2025-06-26'];

  const epgData = [];

  for (const canal of canais) {
    let programas = [];
    for (const data of datas) {
      const programasDoDia = await fetchEPGChannel(canal, data);
      if (programasDoDia && Array.isArray(programasDoDia)) {
        programas = programas.concat(programasDoDia);
      }
    }
    epgData.push({ id: canal, name: canal, programs: programas });
  }

  const xml = buildXML(epgData);

  console.log(xml);

  // Aqui você pode salvar o arquivo com fs.writeFileSync se quiser
}

main();
