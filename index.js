const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const xml2js = require('xml2js');

const BASE_URL = 'https://mi.tv/br/async/channel/';

async function carregarCanais() {
    const xml = fs.readFileSync('channels.xml', 'utf-8');
    const result = await xml2js.parseStringPromise(xml);
    return result.channels.channel.map(canal => ({
        id: canal.$.site_id,
        xmltv_id: canal.$.xmltv_id,
        nome: canal._
    }));
}

function getDatas() {
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);

    const datas = [];
    for (let i = -1; i <= 2; i++) { // Ontem, Hoje, Amanhã, Depois de Amanhã
        const data = new Date(hoje);
        data.setDate(data.getDate() + i);

        const ano = data.getUTCFullYear();
        const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
        const dia = String(data.getUTCDate()).padStart(2, '0');

        datas.push(`${ano}-${mes}-${dia}`);
    }
    return datas;
}

async function buscarProgramacao(canal, data) {
    const url = `${BASE_URL}${canal.id}/${data}/0`;
    let programas = [];

    try {
        const { data: html } = await axios.get(url);
        const $ = cheerio.load(html);

        $('.broadcast').each((_, elem) => {
            const hora = $(elem).find('.time').text().trim();
            if (!hora) return;

            const titulo = $(elem).find('h2').text().trim();
            const descricao = $(elem).find('.synopsis').text().trim();

            const [horas, minutos] = hora.split(':').map(Number);
            const inicio = new Date(`${data}T${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}:00Z`);
            const fim = new Date(inicio.getTime() + 2 * 60 * 60 * 1000); // Duração padrão de 2h

            programas.push({
                start: formatarDataEPG(inicio),
                stop: formatarDataEPG(fim),
                channel: canal.xmltv_id,
                title: titulo,
                desc: descricao
            });
        });

    } catch (error) {
        console.error(`Erro ao buscar ${canal.nome} (${data}):`, error.message);
    }

    return programas;
}

function formatarDataEPG(data) {
    const ano = data.getUTCFullYear();
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(data.getUTCDate()).padStart(2, '0');
    const horas = String(data.getUTCHours()).padStart(2, '0');
    const minutos = String(data.getUTCMinutes()).padStart(2, '0');
    const segundos = String(data.getUTCSeconds()).padStart(2, '0');
    return `${ano}${mes}${dia}${horas}${minutos}${segundos} +0000`;
}

async function gerarEPG() {
    const canais = await carregarCanais();
    const datas = getDatas();

    let epg = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="EPG Generator">\n`;

    for (let canal of canais) {
        epg += `  <channel id="${canal.xmltv_id}">\n    <display-name>${canal.nome}</display-name>\n  </channel>\n`;

        for (let data of datas) {
            const programas = await buscarProgramacao(canal, data);

            for (let prog of programas) {
                epg += `  <programme start="${prog.start}" stop="${prog.stop}" channel="${prog.channel}">\n`;
                epg += `    <title lang="pt">${prog.title}</title>\n`;
                epg += `    <desc lang="pt">${prog.desc}</desc>\n`;
                epg += `    <rating system="Brazil">\n      <value>[Livre]</value>\n    </rating>\n`;
                epg += `  </programme>\n`;
            }
        }
    }

    epg += `</tv>`;
    fs.writeFileSync('epg.xml', epg);
    console.log('✅ EPG gerado com sucesso!');
}

gerarEPG();
