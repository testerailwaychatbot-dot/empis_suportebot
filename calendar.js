import crypto from "node:crypto";

const TIME_ZONE =
  process.env.GOOGLE_CALENDAR_TIME_ZONE || "America/Sao_Paulo";

const DURATION_MINUTES = Math.max(
  15,
  Number(process.env.GOOGLE_CALENDAR_DURATION_MINUTES || 60)
);

let accessTokenCache = {
  token: null,
  expiresAt: 0,
};

function carregarCredenciais() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    return null;
  }

  try {
    const credenciais = JSON.parse(raw);

    if (!credenciais.client_email || !credenciais.private_key) {
      return null;
    }

    return {
      client_email: credenciais.client_email,
      private_key: credenciais.private_key.replace(/\\n/g, "\n"),
    };
  } catch (error) {
    console.error(
      "GOOGLE_SERVICE_ACCOUNT_JSON inválido:",
      error.message
    );

    return null;
  }
}

export function calendarConfigurado() {
  return (
    process.env.GOOGLE_CALENDAR_ENABLED === "true" &&
    Boolean(process.env.GOOGLE_CALENDAR_ID) &&
    Boolean(carregarCredenciais())
  );
}

function base64Url(valor) {
  return Buffer.from(valor)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function criarJwtAssinado(credenciais) {
  const agora = Math.floor(Date.now() / 1000);

  const cabecalho = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: credenciais.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };

  const parteInicial = `${base64Url(
    JSON.stringify(cabecalho)
  )}.${base64Url(JSON.stringify(payload))}`;

  const assinatura = crypto
    .createSign("RSA-SHA256")
    .update(parteInicial)
    .sign(credenciais.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${parteInicial}.${assinatura}`;
}

async function obterAccessToken() {
  const agora = Date.now();

  if (
    accessTokenCache.token &&
    accessTokenCache.expiresAt > agora + 60_000
  ) {
    return accessTokenCache.token;
  }

  const credenciais = carregarCredenciais();

  if (!credenciais) {
    throw new Error("Credenciais do Google Calendar não configuradas.");
  }

  const jwt = criarJwtAssinado(credenciais);

  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resposta.ok) {
    throw new Error(
      `Falha ao obter token Google: ${resposta.status} ${await resposta.text()}`
    );
  }

  const dados = await resposta.json();

  accessTokenCache = {
    token: dados.access_token,
    expiresAt: agora + Number(dados.expires_in || 3600) * 1000,
  };

  return accessTokenCache.token;
}

function dataHoraLocal(data, horario) {
  const match = String(data || "").match(
    /^(\d{2})\/(\d{2})\/(\d{4})$/
  );

  if (!match || !/^\d{2}:\d{2}$/.test(String(horario || ""))) {
    return null;
  }

  const [, dia, mes, ano] = match;

  return `${ano}-${mes}-${dia}T${horario}:00`;
}

function adicionarMinutos(dataHora, minutos) {
  const [data, hora] = dataHora.split("T");
  const [ano, mes, dia] = data.split("-").map(Number);
  const [horas, minutosIniciais] = hora
    .slice(0, 5)
    .split(":")
    .map(Number);

  const resultado = new Date(
    Date.UTC(
      ano,
      mes - 1,
      dia,
      horas,
      minutosIniciais + minutos
    )
  );

  const pad = (numero) => String(numero).padStart(2, "0");

  return (
    `${resultado.getUTCFullYear()}-` +
    `${pad(resultado.getUTCMonth() + 1)}-` +
    `${pad(resultado.getUTCDate())}T` +
    `${pad(resultado.getUTCHours())}:` +
    `${pad(resultado.getUTCMinutes())}:00`
  );
}

function criarJanela(data, horario) {
  const inicio = dataHoraLocal(data, horario);

  if (!inicio) {
    return null;
  }

  return {
    inicio,
    fim: adicionarMinutos(inicio, DURATION_MINUTES),
  };
}

function rfc3339Brasilia(dataHora) {
  return `${dataHora}-03:00`;
}

async function requisicaoGoogle(url, opcoes = {}) {
  const token = await obterAccessToken();

  const resposta = await fetch(url, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opcoes.headers || {}),
    },
  });

  return resposta;
}

export async function verificarDisponibilidade(data, horario) {
  if (!calendarConfigurado()) {
    return {
      configurado: false,
      disponivel: true,
    };
  }

  const janela = criarJanela(data, horario);

  if (!janela) {
    return {
      configurado: true,
      disponivel: false,
    };
  }

  const calendarioId = encodeURIComponent(
    process.env.GOOGLE_CALENDAR_ID
  );

  try {
    const resposta = await requisicaoGoogle(
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        body: JSON.stringify({
          timeMin: rfc3339Brasilia(janela.inicio),
          timeMax: rfc3339Brasilia(janela.fim),
          timeZone: TIME_ZONE,
          items: [
            {
              id: process.env.GOOGLE_CALENDAR_ID,
            },
          ],
        }),
      }
    );

    if (!resposta.ok) {
      throw new Error(
        `${resposta.status} ${await resposta.text()}`
      );
    }

    const dados = await resposta.json();

    const agenda =
      dados.calendars?.[process.env.GOOGLE_CALENDAR_ID];

    const horariosOcupados = agenda?.busy || [];

    return {
      configurado: true,
      disponivel: horariosOcupados.length === 0,
    };
  } catch (error) {
    console.error(
      "Erro ao consultar disponibilidade no Google Calendar:",
      error.message
    );

    return {
      configurado: true,
      disponivel: true,
      erro: error.message,
    };
  }
}

export async function criarEventoAgenda({
  dados,
  protocolo,
  telefone,
}) {
  if (!calendarConfigurado()) {
    return {
      configurado: false,
      criado: false,
    };
  }

  const janela = criarJanela(
    dados.data_agendamento,
    dados.horario
  );

  if (!janela) {
    return {
      configurado: true,
      criado: false,
    };
  }

  const calendarioId = encodeURIComponent(
    process.env.GOOGLE_CALENDAR_ID
  );

  const descricao = [
    `Protocolo: ${protocolo}`,
    `Solicitante: ${dados.nome || "Não informado"}`,
    `Telefone: ${telefone}`,
    `Equipamento: ${dados.equipamento || "Não informado"}`,
    `Quantidade: ${dados.quantidade || "Não informada"}`,
    `Sala: ${dados.sala || "Não informada"}`,
    dados.aplicativos
      ? `Aplicativos: ${dados.aplicativos}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const resposta = await requisicaoGoogle(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarioId}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          summary: `[EMPIS] ${dados.equipamento || "Equipamento"} - ${dados.sala}`,
          description,
          location: dados.sala,
          start: {
            dateTime: janela.inicio,
            timeZone: TIME_ZONE,
          },
          end: {
            dateTime: janela.fim,
            timeZone: TIME_ZONE,
          },
        }),
      }
    );

    if (!resposta.ok) {
      throw new Error(
        `${resposta.status} ${await resposta.text()}`
      );
    }

    const evento = await resposta.json();

    return {
      configurado: true,
      criado: true,
      eventId: evento.id,
    };
  } catch (error) {
    console.error(
      "Erro ao criar evento no Google Calendar:",
      error.message
    );

    return {
      configurado: true,
      criado: false,
      erro: error.message,
    };
  }
}
