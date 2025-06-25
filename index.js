const axios = require('axios');
const fs = require('fs');
const xml2js = require('xml2js');
const { parseISO, addDays, format } = require('date-fns');

const CHANNELS_FILE = './channels.xml';
const OUTPUT_FILE = './epg.xml';

const TIMEZONE_OFFSET = '+0000';
const CUT_HOUR = 3;

async function loadChannels() {
    const xml = fs.readFileSync(CHANNELS_FILE, 'utf-8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xml);
    return result.channels.channel.map(ch => ({
        id: ch.$.xmltv_id,
        miTvId: ch.$.site_id
    }));
}

function formatDate(date) {
    return format(date, 'yyyy-MM-dd');
}

function formatEPGDate(date) {
    return format(date, 'yyyyMMddHHmmss') + ' ' + TIMEZONE_OFFSET;
}

async function fetchEPG(channelId, date) {
    const url = `https://mi.tv/br/async/channel/${channelId}/${formatDate(date)}/0`;
    const response = await axios.get(url);
    return response.data;
}

function splitProgram(program, cutTime, channelId) {
    const programs = [];

    const start = parseISO(program.start);
    const end = parseISO(program.end);

    if (end <= start) {
        // Se o fim for antes do início, adiciona 1 dia ao fim
        end.setUTCDate(end.getUTCDate() + 1);
    }

    if (end <= cutTime) {
        // Todo antes da 03:00
        programs.push({
            start,
            end,
            channelId,
            title: program.title,
            desc: program.description
        });
    } else if (start >= cutTime) {
        // Todo depois da 03:00
        programs.push({
            start: addDays(start, 1),
            end: addDays(end, 1),
            channelId,
            title: program.title,
            desc: program.description
        });
    } else {
        // Corta o programa em dois
        programs.push({
            start,
            end: cutTime,
            channelId,
            title: program.title,
            desc: program.description
        });
        programs.push({
            start: addDays(cutTime, 1),
            end: addDays(end, 1),
            channelId,
            title: program.title,
            desc: program.description
        });
    }

    return programs;
}

async function generateEPG() {
    const channels = await loadChannels();
    const builder = new xml2js.Builder({ headless: true, rootName: 'tv' });

    let epg = { channel: [], programme: [] };

    const dayOffsets = [-2, -1, 0, 1, 2, 3];

    for (const ch of channels) {
        epg.channel.push({
            $: { id: ch.id },
            'display-name': ch.id
        });
    }

    for (const offset of dayOffsets) {
        const baseDate = addDays(new Date(), offset);

        for (const ch of channels) {
            try {
                const epgData = await fetchEPG(ch.miTvId, baseDate);

                // Define o corte para o dia atual
                const cutTime = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), CUT_HOUR, 0, 0));

                for (const program of epgData) {
                    const splitted = splitProgram(program, cutTime, ch.id);

                    for (const prog of splitted) {
                        epg.programme.push({
                            $: {
                                start: formatEPGDate(prog.start),
                                stop: formatEPGDate(prog.end),
                                channel: prog.channelId
                            },
                            title: prog.title,
                            desc: prog.desc
                        });
                    }
                }

            } catch (e) {
                console.error(`Erro ao buscar EPG do canal ${ch.id} no dia ${formatDate(baseDate)}`);
            }
        }
    }

    const xml = builder.buildObject(epg);
    fs.writeFileSync(OUTPUT_FILE, xml);
    console.log('EPG gerado com sucesso!');
}

generateEPG();
