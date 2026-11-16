export const MENU = `Olá sou o suporte virtual EMPIS como posso ajudar? Digite uma opção:

1-Abrir chamado
2-Consultar chamado (envie o protocolo)
3-Falar com um dos suportes (João ou Geliane)
4-Sair`;

export const OPCOES_MENU = {
  "1": ["abrir chamado", "abrir"],
  "2": ["consultar chamado", "consultar chamado envie o protocolo", "consultar protocolo", "consultar", "protocolo"],
  "3": [
    "falar com um dos suportes",
    "falar com um dos suportes joao ou geliane",
    "falar com suporte",
    "falar com suporte tecnico",
    "falar com joao",
    "falar com geliane",
    "joao",
    "geliane",
  ],
  "4": ["sair", "encerrar", "encerrar atendimento"],
};

export const OPCOES_TIPO_CHAMADO = {
  "1": ["urgencia", "urgente"],
  "2": ["agendamento", "agendar"],
};

export const OPCOES_URGENCIA = {
  "1": ["ligar projetor", "projetor"],
  "2": ["computador nao liga", "computador"],
  "3": ["sem internet", "internet"],
  "4": ["outro", "outro problema"],
  "5": ["cancelar chamado"],
};

export const OPCOES_EQUIPAMENTO = {
  "1": ["tablet", "tablets"],
  "2": ["chromebook", "chromebooks"],
  "3": ["outro", "outro equipamento"],
  "4": ["sair", "encerrar"],
};

export const OPCOES_SIM_NAO = {
  "1": ["sim", "s", "yes"],
  "2": ["nao", "n", "no"],
};

export const OPCOES_CANCELAMENTO = {
  "1": ["sim", "s", "cancelar chamado"],
  "2": ["nao", "n", "continuar"],
};

export function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function selecionarOpcao(texto, opcoes) {
  const entrada = normalizar(texto);

  for (const [codigo, alternativas] of Object.entries(opcoes)) {
    const aceitas = new Set([codigo]);

    for (const alternativa of alternativas) {
      const nome = normalizar(alternativa);
      aceitas.add(nome);
      aceitas.add(`${codigo} ${nome}`);
    }

    if (aceitas.has(entrada)) return codigo;
  }

  return null;
}

export function primeiroNome(nome) {
  return String(nome || "").trim().split(/\s+/)[0] || "";
}

export function personalizarResposta(texto, nome) {
  const resposta = String(texto || "");
  const primeiro = primeiroNome(nome);
  if (!primeiro) return resposta;

  if (resposta === MENU) return resposta;
  return `${primeiro}, ${resposta}`;
}
