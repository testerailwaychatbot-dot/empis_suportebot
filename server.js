import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { analisarDataAgendamento, normalizarHorario } from "./datas.js";

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  VERIFY_TOKEN,
} = process.env;

const PORT = Number(process.env.PORT || 8080);
const TIMEOUT_MS = 15000;
const MAX_BODY = 1024 * 1024;

// QR Code é o padrão. Só use WA_MODE=meta se futuramente migrar para a API.
const QR_MODE = (process.env.WA_MODE || "qr").toLowerCase() === "qr";

const required = QR_MODE
  ? ["VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
  : [
      "WHATSAPP_TOKEN",
      "PHONE_NUMBER_ID",
      "APP_SECRET",
      "VERIFY_TOKEN",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_KEY",
    ];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn("Variáveis ausentes:", missing.join(", "));
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Configure SUPABASE_URL e SUPABASE_SERVICE_KEY no ambiente.");
}

// ============================================================
// SUPABASE
// ============================================================

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sb(path, { method = "GET", body, prefer } = {}) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        ...supabaseHeaders(),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(
        "Erro Supabase:",
        path,
        response.status,
        await response.text()
      );
      return null;
    }

    const content = await response.text();
    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error("Falha na comunicação com Supabase:", error.message);
    return null;
  }
}

// ============================================================
// ENVIO DE MENSAGENS
// ============================================================

// No modo QR, wa.js fornece a função de envio diretamente.
// Esta função fica disponível apenas para compatibilidade com a API Meta.
async function sendText(to, body) {
  if (QR_MODE) {
    console.error("Envio padrão da Meta chamado no modo QR. Use o envio fornecido por wa.js.");
    return false;
  }

  try {
    const GRAPH = process.env.GRAPH_URL || "https://graph.facebook.com/v21.0";
    const response = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error("Erro no envio WhatsApp:", response.status, await response.text());
      return false;
    }

    return (await response.json()).messages?.[0]?.id || true;
  } catch (error) {
    console.error("Falha ao enviar mensagem:", error.message);
    return false;
  }
}

// ============================================================
// MENUS
// ============================================================

const MENU = `Olá! Sou o suporte virtual EMPIS.
Como posso ajudar? Digite uma opção:

1 - Abrir chamado
2 - Consultar chamado (envie o protocolo)
3 - Falar com um dos suportes (João Pedro ou Geliane)
4 - Sair

A qualquer momento, digite menu para voltar ao início ou sair para encerrar o atendimento.`;

const MENU_TIPO = `Qual tipo de atendimento deseja?

1 - Urgência
2 - Agendamento

Digite menu para voltar ou sair para encerrar.`;

const MENU_URGENCIA = `Qual é o problema?

1 - Ligar projetor
2 - Computador não liga
3 - Sem Internet
4 - Outro
5 - Cancelar chamado

Digite menu para voltar ou sair para encerrar.`;

const MENU_AGENDAMENTO = `Qual equipamento deseja agendar?

1 - Tablet
2 - Chromebook
3 - Outro
4 - Sair

Digite menu para voltar.`;

const MENU_APLICATIVOS = `Será necessário algum aplicativo específico no tablet?

1 - Sim
2 - Não

Digite menu para voltar ou sair para encerrar.`;

const SAUDACAO = `Olá! Atendimento EMPIS iniciado.
${MENU}`;

const DESPEDIDA = `Atendimento encerrado. Obrigado por entrar em contato com o suporte EMPIS!

Quando precisar de ajuda novamente, basta enviar uma nova mensagem.`;

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function ehSaudacao(texto) {
  const t = normalizar(texto);
  return /^(oi|ola|bom dia|boa tarde|boa noite|ei|eai|e ai|hey|hello|ol[aá] tudo bem)[!.?,\s]*$/i.test(t)
    || /^(bom dia|boa tarde|boa noite)\b/i.test(t);
}

function ehProtocolo(texto) {
  return /^EMPIS-\d{4}-\d{5}$/i.test(String(texto || "").trim());
}

function horarioValido(valor) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(valor || "").trim());
}

function formatarDescricao(dados) {
  const linhas = [];

  if (dados.categoria === "urgencia") {
    linhas.push("TIPO: Atendimento urgente");
    linhas.push(`Problema: ${dados.problema || "Não informado"}`);
    if (dados.descricao_problema) {
      linhas.push(`Descrição adicional: ${dados.descricao_problema}`);
    }
  } else {
    linhas.push("TIPO: Agendamento");
    linhas.push(`Equipamento: ${dados.equipamento || "Não informado"}`);
    linhas.push(`Quantidade: ${dados.quantidade || "Não informada"}`);
    if (dados.aplicativos) {
      linhas.push(`Aplicativos necessários: ${dados.aplicativos}`);
    } else if (dados.precisa_aplicativo === false) {
      linhas.push("Aplicativo específico: Não");
    }
    linhas.push(`Data de uso: ${dados.data_agendamento || "Não informada"}`);
    linhas.push(`Horário: ${dados.horario || "Não informado"}`);
  }

  linhas.push(`Sala: ${dados.sala || "Não informada"}`);
  return linhas.join("\n").slice(0, 2000);
}

// ============================================================
// PROTOCOLO
// ============================================================

// Usa a tabela contadores_protocolo (colunas: ano e ultimo).
async function gerarProtocolo() {
  const ano = new Date().getFullYear();

  for (let tentativa = 0; tentativa < 8; tentativa++) {
    const atual = (await sb(`contadores_protocolo?ano=eq.${ano}&limit=1`))?.[0];

    if (!atual) {
      const criado = await sb("contadores_protocolo", {
        method: "POST",
        prefer: "return=representation",
        body: { ano, ultimo: 1 },
      });

      if (criado?.length) {
        return `EMPIS-${ano}-${String(1).padStart(5, "0")}`;
      }
      continue;
    }

    const proximo = Number(atual.ultimo) + 1;
    const atualizado = await sb(
      `contadores_protocolo?ano=eq.${ano}&ultimo=eq.${atual.ultimo}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: { ultimo: proximo },
      }
    );

    if (atualizado?.length) {
      return `EMPIS-${ano}-${String(proximo).padStart(5, "0")}`;
    }
  }

  return null;
}

// ============================================================
// CONVERSAS
// ============================================================

async function getConversa(telefone) {
  const resultado = await sb(
    `conversas?telefone=eq.${encodeURIComponent(telefone)}&limit=1`
  );

  return resultado?.[0] || {
    telefone,
    wa_id: telefone,
    estado: "inicio",
    dados: {},
    bot_pausado: false,
  };
}

async function saveConversa(conversa) {
  return sb("conversas?on_conflict=telefone", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      ...conversa,
      atualizado_em: new Date().toISOString(),
    },
  });
}

// ============================================================
// CADASTRO E ABERTURA DE CHAMADOS
// ============================================================

async function abrirChamado(conversa, novosDados = {}) {
  const dados = { ...(conversa.dados || {}), ...novosDados };

  if (!dados.nome || !dados.sala || !dados.categoria) {
    return {
      texto: "Faltam informações para abrir o chamado. Digite menu para começar novamente.",
      estado: "menu",
      dados: {},
    };
  }

  let professor = (
    await sb(
      `professores?telefone=eq.${encodeURIComponent(conversa.telefone)}&limit=1`
    )
  )?.[0];

  if (!professor) {
    professor = (
      await sb("professores", {
        method: "POST",
        prefer: "return=representation",
        body: {
          nome: dados.nome,
          telefone: conversa.telefone,
          consentimento_em: new Date().toISOString(),
        },
      })
    )?.[0];
  } else if (professor.nome !== dados.nome) {
    const atualizado = await sb(
      `professores?id=eq.${professor.id}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          nome: dados.nome,
          consentimento_em: new Date().toISOString(),
        },
      }
    );
    if (atualizado?.[0]) professor = atualizado[0];
  }

  if (!professor) {
    return {
      texto: "Não consegui localizar ou cadastrar seus dados no momento. Tente novamente mais tarde.",
      estado: "menu",
      dados: {},
    };
  }

  const numero = await gerarProtocolo();
  if (!numero) {
    return {
      texto: "Não consegui gerar o protocolo agora. Tente novamente em instantes.",
      estado: "menu",
      dados: {},
    };
  }

  const chamado = await sb("chamados", {
    method: "POST",
    prefer: "return=representation",
    body: {
      protocolo: numero,
      professor_id: professor.id,
      categoria: dados.categoria,
      descricao: formatarDescricao(dados),
      local: dados.sala,
      urgencia: dados.categoria === "urgencia" ? "imediata" : "agendada",
      status: "aberto",
      humano: false,
      chave_idempotencia: `${conversa.telefone}-${numero}`,
    },
  });

  if (!chamado?.[0]) {
    return {
      texto: "Não consegui registrar o chamado no banco de dados. Nenhum protocolo foi confirmado. Tente novamente.",
      estado: "menu",
      dados: {},
    };
  }

  const tipo = dados.categoria === "urgencia" ? "urgente" : "agendado";

  return {
    texto: `✅ Chamado ${tipo} registrado com sucesso!

Protocolo: ${numero}

Sala: ${dados.sala}

Guarde esse número para consultar o andamento do atendimento.

Digite menu para voltar ao início ou sair para encerrar.`,
    estado: "menu",
    dados: {},
    protocolo: numero,
    chamado_id: chamado[0].id,
  };
}

// ============================================================
// FLUXO DE ATENDIMENTO
// ============================================================

async function fluxo(conversa, mensagem) {
  const texto = String(mensagem || "").trim();
  const t = normalizar(texto);
  const dados = conversa.dados || {};

  // Comandos que funcionam em qualquer etapa.
  if (t === "menu" || t === "cancelar") {
    return {
      texto: MENU,
      estado: "menu",
      dados: {},
      pausar: false,
    };
  }

  if (t === "sair" || t === "4 sair") {
    return {
      texto: DESPEDIDA,
      estado: "encerrado",
      dados: {},
      pausar: false,
    };
  }

  // Saudações mostram o menu mesmo se a pessoa estiver em outra etapa.
  if (ehSaudacao(texto)) {
    return {
      texto: MENU,
      estado: "menu",
      dados: {},
      pausar: false,
    };
  }

  // Primeira mensagem de uma conversa nova ou atendimento encerrado.
  if (conversa.estado === "inicio" || conversa.estado === "encerrado") {
    return {
      texto: SAUDACAO,
      estado: "menu",
      dados: {},
      pausar: false,
    };
  }

  switch (conversa.estado) {
    // ---------------- MENU PRINCIPAL ----------------
    case "menu": {
      if (t === "1") {
        return {
          texto: "Informe seu nome e sobrenome.\n\nAo continuar você concorda com o uso dos seus dados para atendimento.\n\nDigite 4 para sair ou menu para voltar.",
          estado: "nome",
          dados: {},
        };
      }

      if (t === "2") {
        return {
          texto: "Envie o número do protocolo.\nExemplo: EMPIS-2026-00001\n\nDigite menu para voltar ou sair para encerrar.",
          estado: "consulta_protocolo",
          dados: {},
        };
      }

      if (t === "3") {
        return {
          texto: "Certo! Um dos suportes (João Pedro ou Geliane) foi avisado sobre sua solicitação. Aguarde o contato.\n\nPara voltar ao atendimento automático, digite menu.",
          estado: "menu",
          dados: {},
          pausar: true,
        };
      }

      if (t === "4") {
        return {
          texto: DESPEDIDA,
          estado: "encerrado",
          dados: {},
        };
      }

      return {
        texto: `Não reconheci essa opção.\n\n${MENU}`,
        estado: "menu",
        dados: {},
      };
    }

    // ---------------- NOME ----------------
    case "nome": {
      if (t === "4") {
        return { texto: DESPEDIDA, estado: "encerrado", dados: {} };
      }

      if (texto.length < 3 || !texto.includes(" ")) {
        return {
          texto: "Por favor, informe seu nome e sobrenome.\nExemplo: Maria Silva",
          estado: "nome",
          dados,
        };
      }

      return {
        texto: MENU_TIPO,
        estado: "tipo_chamado",
        dados: { nome: texto },
      };
    }

    // ---------------- TIPO DE CHAMADO ----------------
    case "tipo_chamado": {
      if (t === "1" || t === "urgencia") {
        return {
          texto: MENU_URGENCIA,
          estado: "urgencia_problema",
          dados: { ...dados, categoria: "urgencia" },
        };
      }

      if (t === "2" || t === "agendamento") {
        return {
          texto: MENU_AGENDAMENTO,
          estado: "agendamento_equipamento",
          dados: { ...dados, categoria: "agendamento" },
        };
      }

      return {
        texto: "Opção inválida. Digite 1 para Urgência ou 2 para Agendamento.\n\nDigite menu para voltar.",
        estado: "tipo_chamado",
        dados,
      };
    }

    // ---------------- URGÊNCIA ----------------
    case "urgencia_problema": {
      if (t === "1") {
        return {
          texto: "Entendi: ligar projetor.\n\nEm qual sala está o projetor?",
          estado: "sala_urgencia",
          dados: { ...dados, problema: "Ligar projetor" },
        };
      }

      if (t === "2") {
        return {
          texto: "Entendi: computador não liga.\n\nEm qual sala está o computador?",
          estado: "sala_urgencia",
          dados: { ...dados, problema: "Computador não liga" },
        };
      }

      if (t === "3") {
        return {
          texto: "Entendi: sem Internet.\n\nEm qual sala está ocorrendo o problema?",
          estado: "sala_urgencia",
          dados: { ...dados, problema: "Sem Internet" },
        };
      }

      if (t === "4") {
        return {
          texto: "Descreva, por favor, qual é o outro problema.",
          estado: "problema_outro",
          dados,
        };
      }

      if (t === "5") {
        return {
          texto: "Tem certeza de que deseja cancelar a abertura deste chamado?\n\nDigite SIM para cancelar ou NÃO para continuar.",
          estado: "confirmar_cancelamento",
          dados,
        };
      }

      return {
        texto: MENU_URGENCIA,
        estado: "urgencia_problema",
        dados,
      };
    }

    case "problema_outro": {
      if (texto.length < 3) {
        return {
          texto: "Escreva uma descrição um pouco mais detalhada do problema.",
          estado: "problema_outro",
          dados,
        };
      }

      return {
        texto: "Obrigado pela descrição. Em qual sala está ocorrendo o problema?",
        estado: "sala_urgencia",
        dados: {
          ...dados,
          problema: "Outro problema",
          descricao_problema: texto,
        },
      };
    }

    case "confirmar_cancelamento": {
      if (t === "sim" || t === "s" || t === "1") {
        return {
          texto: "A abertura deste chamado foi cancelada. Nenhum chamado foi registrado.\n\n" + MENU,
          estado: "menu",
          dados: {},
        };
      }

      if (t === "nao" || t === "n" || t === "2") {
        return {
          texto: MENU_URGENCIA,
          estado: "urgencia_problema",
          dados,
        };
      }

      return {
        texto: "Responda SIM para cancelar ou NÃO para continuar.",
        estado: "confirmar_cancelamento",
        dados,
      };
    }

    case "sala_urgencia": {
      if (texto.length < 1) {
        return {
          texto: "Informe a sala onde está ocorrendo o problema.",
          estado: "sala_urgencia",
          dados,
        };
      }

      return abrirChamado(conversa, { sala: texto });
    }

    // ---------------- AGENDAMENTO ----------------
    case "agendamento_equipamento": {
      if (t === "1") {
        return {
          texto: MENU_APLICATIVOS,
          estado: "tablet_aplicativo",
          dados: { ...dados, equipamento: "Tablet" },
        };
      }

      if (t === "2") {
        return {
          texto: "Quantos Chromebooks deseja agendar?",
          estado: "quantidade",
          dados: { ...dados, equipamento: "Chromebook" },
        };
      }

      if (t === "3") {
        return {
          texto: "Qual outro equipamento deseja agendar?",
          estado: "equipamento_outro",
          dados,
        };
      }

      if (t === "4") {
        return {
          texto: DESPEDIDA,
          estado: "encerrado",
          dados: {},
        };
      }

      return {
        texto: MENU_AGENDAMENTO,
        estado: "agendamento_equipamento",
        dados,
      };
    }

    case "tablet_aplicativo": {
      if (t === "1" || t === "sim") {
        return {
          texto: "Informe os nomes dos aplicativos necessários no tablet.",
          estado: "tablet_aplicativos",
          dados: { ...dados, precisa_aplicativo: true },
        };
      }

      if (t === "2" || t === "nao") {
        return {
          texto: "Quantos tablets deseja agendar?",
          estado: "quantidade",
          dados: { ...dados, precisa_aplicativo: false, aplicativos: "" },
        };
      }

      return {
        texto: "Responda 1 para Sim ou 2 para Não.\n\n" + MENU_APLICATIVOS,
        estado: "tablet_aplicativo",
        dados,
      };
    }

    case "tablet_aplicativos": {
      if (texto.length < 2) {
        return {
          texto: "Informe o nome de pelo menos um aplicativo ou digite menu para voltar.",
          estado: "tablet_aplicativos",
          dados,
        };
      }

      return {
        texto: "Anotei os aplicativos necessários.\n\nQuantos tablets deseja agendar?",
        estado: "quantidade",
        dados: { ...dados, aplicativos: texto },
      };
    }

    case "equipamento_outro": {
      if (texto.length < 2) {
        return {
          texto: "Informe o nome do equipamento que deseja agendar.",
          estado: "equipamento_outro",
          dados,
        };
      }

      return {
        texto: `Quantas unidades de ${texto} deseja agendar?`,
        estado: "quantidade",
        dados: { ...dados, equipamento: texto },
      };
    }

    case "quantidade": {
      const quantidade = Number(texto);
      if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100) {
        return {
          texto: "Informe uma quantidade inteira entre 1 e 100.",
          estado: "quantidade",
          dados,
        };
      }

      return {
        texto: "Em qual sala o equipamento será utilizado?",
        estado: "sala_agendamento",
        dados: { ...dados, quantidade },
      };
    }

    case "sala_agendamento": {
      if (!texto) {
        return {
          texto: "Informe a sala onde o equipamento será utilizado.",
          estado: "sala_agendamento",
          dados,
        };
      }

      return {
        texto: "Para qual data deseja agendar? Informe no formato DD/MM/AAAA. O agendamento deve ser feito com pelo menos 1 dia de antecedência.",
        estado: "data_agendamento",
        dados: { ...dados, sala: texto },
      };
    }

    case "data_agendamento": {
      const analise = analisarDataAgendamento(texto);
      if (!analise.ok) {
        const aviso =
          analise.motivo === "formato"
            ? "Não consegui entender essa data. Informe no formato DD/MM/AAAA. Exemplo: 25/12/2026."
            : analise.motivo === "passado"
              ? "Essa data já passou. Informe uma data a partir de amanhã, no formato DD/MM/AAAA."
              : "O agendamento precisa de pelo menos 1 dia de antecedência. Informe uma data a partir de amanhã, no formato DD/MM/AAAA.";
        return {
          texto: aviso,
          estado: "data_agendamento",
          dados,
        };
      }

      return {
        texto: "Para qual horário deseja agendar? Informe no formato HH:MM. Exemplo: 13:30.",
        estado: "horario_agendamento",
        dados: { ...dados, data_agendamento: analise.data },
      };
    }

    case "horario_agendamento": {
      const horario = normalizarHorario(texto);
      if (!horario) {
        return {
          texto: "Horário inválido. Informe no formato HH:MM. Exemplo: 13:30.",
          estado: "horario_agendamento",
          dados,
        };
      }

      return abrirChamado(conversa, { horario });
    }

    // ---------------- CONSULTA DE CHAMADO ----------------
    case "consulta_protocolo": {
      if (!ehProtocolo(texto)) {
        return {
          texto: "O protocolo não está no formato esperado.\nExemplo: EMPIS-2026-00001\n\nEnvie novamente ou digite menu para voltar.",
          estado: "consulta_protocolo",
          dados,
        };
      }

      const professor = (
        await sb(
          `professores?telefone=eq.${encodeURIComponent(conversa.telefone)}&limit=1`
        )
      )?.[0];

      if (!professor) {
        return {
          texto: "Não encontrei um cadastro associado a este número. Digite menu para voltar.",
          estado: "menu",
          dados: {},
        };
      }

      const chamado = (
        await sb(
          `chamados?protocolo=eq.${encodeURIComponent(texto.toUpperCase())}&professor_id=eq.${professor.id}&limit=1`
        )
      )?.[0];

      if (!chamado) {
        return {
          texto: "Não encontrei esse protocolo entre os chamados vinculados ao seu número. Confira o número e tente novamente, ou digite menu para voltar.",
          estado: "consulta_protocolo",
          dados: {},
        };
      }

      return {
        texto: `Consulta de chamado EMPIS

Protocolo: ${chamado.protocolo}
Status: ${chamado.status}

Digite menu para voltar ao início.`,
        estado: "menu",
        dados: {},
      };
    }

    default:
      return {
        texto: MENU,
        estado: "menu",
        dados: {},
        pausar: false,
      };
  }
}

// ============================================================
// PROCESSAMENTO DE MENSAGENS
// ============================================================

async function handleMessage(mensagem, send = sendText) {
  const telefone = String(mensagem.from || "").replace(/\D/g, "");
  const texto = mensagem.type === "text" ? String(mensagem.text?.body || "") : "";
  const idMensagem = mensagem.id || `sem-id-${crypto.randomUUID()}`;

  if (!telefone) {
    console.warn("Mensagem recebida sem número de origem.");
    return;
  }

  // Evita processar novamente a mesma mensagem.
  const duplicada = await sb(
    `mensagens?wamid=eq.${encodeURIComponent(idMensagem)}&select=id&limit=1`
  );

  if (duplicada?.length) return;

  await sb("mensagens", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      wamid: idMensagem,
      direcao: "entrada",
      remetente: telefone,
      destinatario: "EMPIS",
      conteudo: texto || `[${mensagem.type || "mensagem"}]`,
      tipo: mensagem.type || "other",
      enviada: true,
    },
  });

  const conversa = await getConversa(telefone);
  const comando = normalizar(texto);
  const comandoPermitidoPausado =
    comando === "menu" ||
    comando === "cancelar" ||
    comando === "sair" ||
    ehSaudacao(texto);

  // Quando o usuário pede atendimento humano, o bot aguarda.
  // Os comandos menu/sair/cancelar e saudações continuam disponíveis.
  if (conversa.bot_pausado && !comandoPermitidoPausado) {
    return;
  }

  const resposta = texto
    ? await fluxo(conversa, texto)
    : {
        texto: "Por enquanto consigo entender apenas mensagens de texto. Digite menu para ver as opções.",
        estado: conversa.estado || "menu",
        dados: conversa.dados || {},
        pausar: !!conversa.bot_pausado,
      };

  await saveConversa({
    telefone,
    wa_id: telefone,
    estado: resposta.estado,
    dados: resposta.dados || {},
    bot_pausado: !!resposta.pausar,
  });

  const idEnviado = await send(telefone, resposta.texto);

  await sb("mensagens", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      wamid: typeof idEnviado === "string" ? idEnviado : null,
      direcao: "saida",
      remetente: "EMPIS",
      destinatario: telefone,
      conteudo: resposta.texto,
      tipo: "text",
      protocolo: resposta.protocolo || null,
      chamado_id: resposta.chamado_id || null,
      enviada: !!idEnviado,
    },
  });
}

// ============================================================
// CONEXÃO WHATSAPP POR QR CODE (BAILEYS)
// ============================================================

let waState = {
  status: "desativado",
  qr: null,
  me: null,
};

if (QR_MODE) {
  try {
    const wa = await import("./wa.js");
    waState = wa.state;
    wa.startWhatsApp(handleMessage).catch((error) => {
      console.error("Erro ao iniciar WhatsApp:", error);
    });
  } catch (error) {
    console.error(
      "Falha ao carregar o WhatsApp (Baileys). Verifique as dependências e o arquivo wa.js:",
      error
    );
  }
}

// ============================================================
// SIMULADOR
// ============================================================

const SIM = process.env.SIMULATOR === "1";
const simHtml = SIM
  ? readFileSync(new URL("./sim.html", import.meta.url), "utf8")
  : "";

// ============================================================
// SERVIDOR HTTP
// ============================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
    return res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
  }

  // Página para visualizar o QR Code. Protegida por VERIFY_TOKEN.
  if (QR_MODE && req.method === "GET" && url.pathname === "/qr") {
    if (!VERIFY_TOKEN || url.searchParams.get("key") !== VERIFY_TOKEN) {
      return res.writeHead(403).end("Acesso negado");
    }

    let conteudo;

    if (waState.status === "conectado") {
      const numero = String(waState.me || "").split(":")[0].split("@")[0];
      conteudo = `<h2>WhatsApp conectado</h2><p>Número: ${numero}</p>`;
    } else if (waState.qr) {
      conteudo = `<h2>Escaneie com o WhatsApp</h2>
        <p>No celular: Aparelhos conectados &gt; Conectar um aparelho</p>
        <img alt="QR Code do WhatsApp" src="${waState.qr}" style="max-width:320px;width:100%">`;
    } else {
      conteudo = `<h2>${String(waState.status || "Iniciando").replace(/[<>&"]/g, "")}</h2>`;
    }

    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="5">
          <title>WhatsApp EMPIS</title>
        </head>
        <body style="font-family:system-ui;text-align:center;padding:24px">
          ${conteudo}
          <p style="color:#888">Estado: ${String(waState.status || "").replace(/[<>&"]/g, "")}</p>
        </body>
        </html>`);
  }

  if (SIM && req.method === "GET" && (url.pathname === "/" || url.pathname === "/sim")) {
    return res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(simHtml);
  }

  // O simulador utiliza o mesmo fluxo e o mesmo banco do WhatsApp.
  if (SIM && req.method === "POST" && url.pathname === "/simulate") {
    let body = "";
    let tamanhoExcedido = false;

    req.on("data", (parte) => {
      body += parte;
      if (body.length > MAX_BODY) {
        tamanhoExcedido = true;
        res.writeHead(413).end("Conteúdo muito grande");
        req.destroy();
      }
    });

    req.on("end", async () => {
      if (tamanhoExcedido) return;

      try {
        const { phone, text, reset } = JSON.parse(body);
        const telefone = "5500" +
          String(phone || "0").replace(/\D/g, "").slice(-9).padStart(9, "0");

        if (reset) {
          await sb(
            `mensagens?or=(remetente.eq.${telefone},destinatario.eq.${telefone})`,
            { method: "DELETE" }
          );
          await sb(`conversas?telefone=eq.${telefone}`, { method: "DELETE" });

          const professores =
            (await sb(`professores?telefone=eq.${telefone}&select=id`)) || [];

          for (const professor of professores) {
            await sb(`chamados?professor_id=eq.${professor.id}`, {
              method: "DELETE",
            });
            await sb(`professores?id=eq.${professor.id}`, {
              method: "DELETE",
            });
          }

          return res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ replies: [] }));
        }

        const respostas = [];

        await handleMessage(
          {
            from: telefone,
            id: `wamid.sim${crypto.randomUUID()}`,
            type: "text",
            text: { body: String(text || "") },
          },
          async (_destino, resposta) => {
            respostas.push(resposta);
            return `wamid.sim${crypto.randomUUID()}`;
          }
        );

        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ replies: respostas }));
      } catch (error) {
        console.error("Erro no simulador:", error);
        res.writeHead(400).end(String(error.message));
      }
    });

    return;
  }

  // Rota Meta mantida apenas para compatibilidade futura.
  // Não é necessária no funcionamento por QR Code.
  if (!QR_MODE && req.method === "GET" && url.pathname === "/webhook") {
    if (
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === VERIFY_TOKEN
    ) {
      return res.writeHead(200).end(url.searchParams.get("hub.challenge"));
    }
    return res.writeHead(403).end();
  }

  if (!QR_MODE && req.method === "POST" && url.pathname === "/webhook") {
    const partes = [];
    let tamanho = 0;
    let excedeu = false;

    req.on("data", (parte) => {
      tamanho += parte.length;

      if (tamanho > MAX_BODY) {
        excedeu = true;
        if (!res.headersSent) res.writeHead(413).end();
        req.destroy();
        return;
      }

      partes.push(parte);
    });

    req.on("end", () => {
      if (excedeu) return;

      const bruto = Buffer.concat(partes);

      if (!APP_SECRET) return res.writeHead(401).end();

      const assinatura = req.headers["x-hub-signature-256"];
      const esperada =
        "sha256=" +
        crypto.createHmac("sha256", APP_SECRET).update(bruto).digest("hex");

      const a = Buffer.from(esperada);
      const b = Buffer.from(assinatura || "");

      if (
        !assinatura ||
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
      ) {
        return res.writeHead(401).end();
      }

      res.writeHead(200).end("ok");

      try {
        const payload = JSON.parse(bruto);

        for (const entrada of payload.entry || []) {
          for (const alteracao of entrada.changes || []) {
            for (const mensagem of alteracao.value?.messages || []) {
              handleMessage(mensagem).catch(console.error);
            }
          }
        }
      } catch (error) {
        console.error("Payload inválido:", error.message);
      }
    });

    return;
  }

  res
    .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    .end("Servidor de atendimento EMPIS online");
});

server.on("error", (error) => {
  console.error("Erro no servidor HTTP:", error);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor EMPIS ouvindo na porta ${PORT}`);
  console.log(`Modo WhatsApp: ${QR_MODE ? "QR Code (Baileys)" : "API Meta"}`);
});

export { server };
