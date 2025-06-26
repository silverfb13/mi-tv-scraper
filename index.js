const axios = require('axios');
const fs = require('fs');
const { parseStringPromise, Builder } = require('xml2js');

const CHANNELS_XML = 'channels.xml';
const EPG_XML = 'epg.xml';

(async () => {
    try {
        // Função para formatar número com dois dígitos
        const pad = (num) => num.toString().padStart(2, '0');

        // Datas: ontem, hoje, amanhã, depois de amanhã
        const now = new Date();
        now.setUTCHours(0, 0, 0, 0);

        const dates = [
            new Date(now.getTime() - 86400000), // Ontem
            new Date(now.getTime()),            // Hoje
            new Date(now.getTime() + 86400000), // Amanhã
            new Date(now.getTime() + 2 * 86400000) // Depois de amanhã
        ];

        const dateStrings = dates.map(date =>
            `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
        );

        // Carregar canais
        const channelsData = fs.readFileSync(CHANNELS_XML, 'utf-8');
        const channelsXml = await parseStringPromise(channelsData);
        const channels = channelsXml.channels.channel.map(c => ({
            id: c.$.site_id.replace('br#', ''),
            name: c._
        }));

        let epg = {
            tv: {
                $: { "source-info-name": "mi.tv", "source-info-url": "https://mi.tv", "generator-info-name": "Custom", "generator-info-url": "https://mi.tv" },
                channel: [],
                programme: []
            }
        };

        for (let channel of channels) {
            epg.tv.channel.push({
                $: { id: channel.id },
                'display-name': channel.name
            });

            for (let dateStr of dateStrings) {
                const url = `https://mi.tv/br/async/channel/${channel.id}/${dateStr}/0`;
                console.log(`Buscando ${url}`);

                try {
                    const response = await axios.get(url);
                    const html = response.data;

                    const regexProgram = /<li[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span class="time">([\d:]+)<\/span>[\s\S]*?<h2>\s*(?:<img[^>]+>)?\s*([^<]+)\s*<\/h2>[\s\S]*?<p class="synopsis">\s*([\s\S]*?)\s*<\/p>/g;
                    let match;
                    let programas = [];

                    while ((match = regexProgram.exec(html)) !== null) {
                        const time = match[2];
                        const title = match[3];
                        const desc = match[4];

                        const startDate = new Date(`${dateStr}T${time}:00Z`);

                        let startTime = new Date(startDate);
                        let addDay = false;
                        let moveDay = false;

                        // Verifica se precisa adicionar +1 dia no horário
                        if (startTime.getUTCHours() >= 0 && startTime.getUTCHours() < 3) {
                            startTime.setUTCDate(startTime.getUTCDate() + 1);
                        }

                        programas.push({
                            startTime,
                            title,
                            desc
                        });
                    }

                    // Ordenar para garantir que o primeiro programa do dia seja conhecido
                    programas.sort((a, b) => a.startTime - b.startTime);

                    if (programas.length === 0) continue;

                    const firstProgramHour = programas[0].startTime.getUTCHours();

                    for (let i = 0; i < programas.length; i++) {
                        let prog = programas[i];
                        let start = prog.startTime;
                        let stop = (i + 1 < programas.length) ? programas[i + 1].startTime : new Date(start.getTime() + 3600000);

                        let moveToNextDay = false;

                        // Se estiver entre 03:00 e o horário do primeiro programa → muda para o próximo dia no XML
                        if (start.getUTCHours() >= 3 && start.getUTCHours() < firstProgramHour) {
                            moveToNextDay = true;
                        }

                        let startXml = formatXmlTime(start);
                        let stopXml = formatXmlTime(stop);

                        let channelId = channel.id;
                        if (moveToNextDay) {
                            let nextDate = new Date(dateStr);
                            nextDate.setUTCDate(nextDate.getUTCDate() + 1);
                            let nextDateStr = `${nextDate.getUTCFullYear()}-${pad(nextDate.getUTCMonth() + 1)}-${pad(nextDate.getUTCDate())}`;
                            startXml = startXml.replace(dateStr.replace(/-/g, ''), nextDateStr.replace(/-/g, ''));
                            stopXml = stopXml.replace(dateStr.replace(/-/g, ''), nextDateStr.replace(/-/g, ''));
                        }

                        epg.tv.programme.push({
                            $: { start: startXml, stop: stopXml, channel: channelId },
                            title: [{ _: prog.title, $: { lang: 'pt' } }],
                            desc: [{ _: prog.desc, $: { lang: 'pt' } }]
                        });
                    }
                } catch (err) {
                    console.error(`Erro ao buscar ${url}: ${err.message}`);
                }
            }
        }

        const builder = new Builder();
        const xml = builder.buildObject(epg);
        fs.writeFileSync(EPG_XML, xml);
        console.log('EPG atualizado com sucesso!');
    } catch (err) {
        console.error('Erro geral:', err.message);
    }
})();

function pad(num) {
    return num.toString().padStart(2, '0');
}

function formatXmlTime(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00 +0000`;
}
