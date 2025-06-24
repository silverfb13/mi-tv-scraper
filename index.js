function formatDateWithOffset(date) {
  // Formata date para: YYYYMMDDHHmmss + offset -0300 (sem converter pra UTC)
  // Exemplo: 20250623060000 -0300
  const pad = (n) => n.toString().padStart(2, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  // Fuso horário fixo -0300
  const offset = '-0300';

  return `${year}${month}${day}${hours}${minutes}${seconds} ${offset}`;
}

async function fetchChannelPrograms(channelId, date) {
  const url = `https://mi.tv/br/async/channel/${channelId}/${date}/0`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const $ = load(response.data);
    const programs = [];

    $('li').each((_, element) => {
      const time = $(element).find('.time').text().trim();
      const title = $(element).find('h2').text().trim();
      const description = $(element).find('.synopsis').text().trim();

      if (time && title) {
        const [hours, minutes] = time.split(':').map(Number);

        // Cria a data base com o dia da programação e hora do programa
        let startDate = new Date(`${date}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00`);

        // Se horário for menor que 06:00 (por exemplo), pode indicar que o programa é do dia seguinte, incrementa o dia
        // Isso depende do seu contexto, ajuste se necessário
        if (hours < 6) {
          startDate.setDate(startDate.getDate() + 1);
        }

        const start = formatDateWithOffset(startDate);

        // Considera duração padrão de 90 minutos
        const endDate = new Date(startDate.getTime() + 90 * 60000);
        const end = formatDateWithOffset(endDate);

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
