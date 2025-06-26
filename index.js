const fs = require('fs');
const axios = require('axios');
const { parseStringPromise, Builder } = require('xml2js');

const CHANNELS_XML = './channels.xml';
const OUTPUT_XML = './epg.xml';

const BASE_URL = 'https://mi.tv/br/async/channel/';

function getDateLabel(offset) {
    const today = new Date();
    today.setUTCDate(today.getUTCDate() + offset);
    return today.toISOString().split('T')[0];
}

async function fetchEPGForChannel(channelId) {
    let programmes = [];

    for (let offset = -1; offset <= 4; offset++) { // -1 (ontem) até +4 (hoje + 3 dias)
        let dateLabel = getDateLabel(offset);
        let url = `${BASE_URL}${channelId}/${dateLabel}/0`;

        try {
            const response = await axios.get(url);
            const data = response.data;

            if (!Array.isArray(data)) continue;

            let lastProgramStart = null;
            if (data.length > 0) {
                lastProgramStart = data[data.length - 1].start;
            }

            const lastStartHour = lastProgramStart ? parseInt(lastProgramStart.split(':')[0], 10) : 0;

            data.forEach(item => {
                let [hour, minute] = item.start.split(':').map(Number);
                let startDate = new Date(`${dateLabel}T${item.start}:00Z`);

                // Adicionar +1 dia se estiver entre 00:00 e o início do último programa
                if (hour >= 0 && hour < lastStartHour) {
                    startDate.setUTCDate(startDate.getUTCDate() + 1);
                }

                let endDate = new Date(startDate.getTime() + (item.duration * 60000));

                // Verificar se precisa mover para o dia seguinte no XML (se estiver entre 03:00 e o início do último programa)
                let moveToNextDay = hour >= 3 && hour < lastStartHour;

                programmes.push({
                    start: formatDate(startDate),
                    stop: formatDate(endDate),
                    channel: channelId,
                    title: [{ _: item.title, $: { lang: 'pt' } }],
                    desc: [{ _: item.description || '', $: { lang: 'pt' } }],
                    moveToNextDay: moveToNextDay
                });
            });
        } catch (err) {
            console.error(`Erro ao buscar EPG para canal ${channelId} no dia ${dateLabel}:`, err.message);
        }
    }

    return programmes;
}

function formatDate(date) {
    return date.toISOString().replace(/[-:]/g, '').split('.')[0] + ' +0000';
}

async function buildEPG() {
    const channelsXml = fs.readFileSync(CHANNELS_XML, 'utf8');
    const channelsObj = await parseStringPromise(channelsXml);
    const channels = channelsObj.channels.channel;

    let epg = { tv: { channel: [], programme: [] } };

    for (let chan of channels) {
        const channelId = chan.$.xmltv_id || '';
        const channelName = chan._ || '';

        epg.tv.channel.push({
            $: { id: channelId },
            'display-name': [{ _: channelName, $: { lang: 'pt' } }]
        });

        console.log(`🔄 Buscando EPG para: ${channelName}`);
        let programmes = await fetchEPGForChannel(chan.$.site_id);

        for (let prog of programmes) {
            if (prog.moveToNextDay) {
                // Mover para o próximo dia no XML (aumenta o dia na data de referência)
                let newStart = new Date(prog.start.substring(0, 8).replace(/(..)(..)(..)/, '$1-$2-$3') + 'T' + prog.start.substring(8, 14) + 'Z');
                newStart.setUTCDate(newStart.getUTCDate() + 1);

                let newStop = new Date(prog.stop.substring(0, 8).replace(/(..)(..)(..)/, '$1-$2-$3') + 'T' + prog.stop.substring(8, 14) + 'Z');
                newStop.setUTCDate(newStop.getUTCDate() + 1);

                epg.tv.programme.push({
                    $: {
                        start: formatDate(newStart),
                        stop: formatDate(newStop),
                        channel: prog.channel
                    },
                    title: prog.title,
                    desc: prog.desc
                });
            } else {
                epg.tv.programme.push({
                    $: {
                        start: prog.start,
                        stop: prog.stop,
                        channel: prog.channel
                    },
                    title: prog.title,
                    desc: prog.desc
                });
            }
        }
    }

    const builder = new Builder();
    const xml = builder.buildObject(epg);
    fs.writeFileSync(OUTPUT_XML, xml);
    console.log('✅ EPG atualizado com sucesso!');
}

buildEPG();
