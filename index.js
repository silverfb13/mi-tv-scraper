import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import fs from 'fs/promises';

// Função para obter datas no formato yyyy-mm-dd para ontem, hoje, amanhã e depois de amanhã
function getDates() {
  const today = new Date();
  const dates = [];

  for (let offset = -1; offset <= 2; offset++) {
    const d = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() + offset
    ));
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates; // [ontem, hoje, amanha, depois_amanha]
}

async function loadChannels() {
  const xmlChannels = await fs.readFile('channels.xml', 'utf-8');
  const parsed = await parseStringPromise(xmlChannels);

  const channels = [];

  parsed.channels.channel.forEach(ch => {
    let rawId = ch.$.site_id; // ex: "br#band-belem"
    let cleanId = rawId.includes('br#') ? rawId.split('br#')[1] : rawId;
    channels.push({
      id: cleanId,
      xmltv_id: ch.$.xmltv_id || '',
      name: ch._
    });
  });

  return channels;
}

// Função que ajusta as programações entre 00:00 e 03:00 para o próximo dia no XML
function ajustarProgramasEPG(programas, dataReferencia) {
  // dataReferencia é uma string yyyy-mm-dd para o dia que estamos processando (GMT+0)
  // Retorna um array de programas ajustados com início e fim em formato ISO para XMLTV

  const programasAjustados = [];

  for (let i = 0; i < programas.length; i++) {
    const prog = programas[i];
    // prog.time é "HH:mm" em GMT+0, convertemos para Date
    let [hora, min] = prog.time.split(':').map(Number);

    // Cria data inicial do programa
    let inicio = new Date(`${dataReferencia}T${prog.time}:00Z`);

    // Para achar fim, pega o horário do próximo programa ou considera +1h se for o último
    let fim;
    if (i + 1 < programas.length) {
      let [horaFim, minFim] = programas[i + 1].time.split(':').map(Number);
      fim = new Date(`${dataReferencia}T${programas[i + 1].time}:00Z`);
      // Se fim < inicio, é dia seguinte
      if (fim <= inicio) {
        fim.setUTCDate(fim.getUTCDate() + 1);
      }
    } else {
      // Último programa, vamos considerar duração fixa de 1 hora (ou você pode ajustar)
      fim = new Date(inicio);
      fim.setUTCHours(fim.getUTCHours() + 1);
    }

    // Regra 2: Se o horário inicial está entre 00:00 e 03:00 (GMT+0), adiciona 1 dia no XML (data de exibição)
    // Além disso, se o programa atravessa 03:00, divide em dois blocos

    // Verifica se inicio está entre 00:00 e 03:00
    if (inicio.getUTCHours() < 3) {
      // Ajusta o início e fim para o dia seguinte
      let inicioNovo = new Date(inicio);
      inicioNovo.setUTCDate(inicioNovo.getUTCDate() + 1);

      let fimNovo = new Date(fim);
      fimNovo.setUTCDate(fimNovo.getUTCDate() + 1);

      // Verifica se programa atravessa 03:00 (ou seja, fim > 03:00 do dia atual)
      let tresHoras = new Date(dataReferencia + 'T03:00:00Z');

      if (fim > tresHoras && inicio < tresHoras) {
        // Divide em dois programas:
        // Parte 1: inicio até 03:00 no dia atual
        programasAjustados.push({
          start: inicio.toISOString().replace(/[-:]|\.\d{3}/g, ''),
          stop: tresHoras.toISOString().replace(/[-:]|\.\d{3}/g, ''),
          title: prog.title,
          desc: prog.desc || ''
        });

        // Parte 2: 03:00 até fim no dia seguinte (já ajustado)
        programasAjustados.push({
          start: tresHoras.toISOString().replace(/[-:]|\.\d{3}/g, '').slice(0, 8) + 'T030000Z'.slice(9), // 03:00 do dia seguinte
          stop: fimNovo.toISOString().replace(/[-:]|\.\d{3}/g, ''),
          title: prog.title,
          desc: prog.desc || ''
        });
      } else {
        // Programa normal, só ajusta o dia para o próximo
        programasAjustados.push({
          start: inicioNovo.toISOString().replace(/[-:]|\.\d{3}/g, ''),
          stop: fimNovo.toISOString().replace(/[-:]|\.\d{3}/g, ''),
          title: prog.title,
          desc: prog.desc || ''
        });
      }

    } else {
      // Programa normal (fora do intervalo 00-03)
      programasAjustados.push({
        start: inicio.toISOString().replace(/[-:]|\.\d{3}/g, ''),
        stop: fim.toISOString().replace(/[-:]|\.\d{3}/g, ''),
        title: prog.title,
        desc: prog.desc || ''
      });
    }
  }

  return programasAjustados;
}

async function fetchEPGForChannel(channelId, date) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;

  const res = await axios.get(url);
  // Supondo que res.data seja JSON com array de programas { time, title, desc }
  // Você pode precisar ajustar conforme a estrutura real da resposta

  // Exemplo: res.data = [{ time: "05:30", title: "Programa X", desc: "..." }, ...]

  return res.data;
}

async function gerarEPG() {
  const channels = await loadChannels();
  const dates = getDates();

  let epgXML = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="mi.tv scraper" source-info-url="https://mi.tv" source-info-name="mi.tv" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;

  for (const ch of channels) {
    epgXML += `  <channel id="${ch.id}">\n`;
    epgXML += `    <display-name>${ch.name}</display-name>\n`;
    epgXML += `  </channel>\n`;

    for (const date of dates) {
      const programas = await fetchEPGForChannel(ch.id, date);

      const programasAjustados = ajustarProgramasEPG(programas, date);

      for (const prog of programasAjustados) {
        epgXML += `  <programme start="${prog.start}" stop="${prog.stop}" channel="${ch.id}">\n`;
        epgXML += `    <title lang="pt">${prog.title}</title>\n`;
        if (prog.desc) {
          epgXML += `    <desc lang="pt">${prog.desc}</desc>\n`;
        }
        epgXML += `  </programme>\n`;
      }
    }
  }

  epgXML += `</tv>`;

  await fs.writeFile('epg.xml', epgXML, 'utf-8');
  console.log('EPG gerado com sucesso!');
}

// Função para agendar a execução às 00:00 e 12:00
function agendarAtualizacao() {
  const agora = new Date();
  const hora = agora.getUTCHours();
  const minutos = agora.getUTCMinutes();
  const segundos = agora.getUTCSeconds();

  // Próxima execução será às 00:00 ou 12:00
  let proximaExecucao;

  if (hora < 12) {
    proximaExecucao = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 12, 0, 0));
  } else {
    // Se passou das 12:00, agenda para 00:00 do próximo dia
    proximaExecucao = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() + 1, 0, 0, 0));
  }

  const delay = proximaExecucao.getTime() - agora.getTime();

  setTimeout(async () => {
    try {
      await gerarEPG();
      agendarAtualizacao(); // Agenda próxima
    } catch (e) {
      console.error('Erro ao gerar EPG:', e);
      agendarAtualizacao(); // Agenda próxima mesmo com erro
    }
  }, delay);
}

(async () => {
  await gerarEPG();
  agendarAtualizacao();
})();
