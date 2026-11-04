// Validação de datas de agendamento. Usa sempre o fuso de São Paulo para
// definir "hoje": o servidor roda em UTC, e depois das 21h (Brasília) o dia
// em UTC já é o seguinte, o que fazia "amanhã" ser rejeitado como "hoje".

const TZ = "America/Sao_Paulo";

export function hojeEmSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const pega = (tipo) => Number(partes.find((p) => p.type === tipo).value);
  return { ano: pega("year"), mes: pega("month"), dia: pega("day") };
}

// Número do dia para comparar datas sem depender de fuso.
function numeroDoDia(ano, mes, dia) {
  return Math.floor(Date.UTC(ano, mes - 1, dia) / 86400000);
}

function calendarioValido(ano, mes, dia) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return (
    d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
  );
}

const p2 = (n) => String(n).padStart(2, "0");

// Retorna { ok: true, data: "DD/MM/AAAA" } ou { ok: false, motivo: "formato" | "passado" | "proxima" }.
export function analisarDataAgendamento(valor, agora = new Date()) {
  const bruto = String(valor ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim();

  const hoje = hojeEmSaoPaulo(agora);
  let dia, mes, ano;

  // DD/MM/AAAA, DD-MM-AA, DD.MM, também dentro de uma frase ("dia 25/12/2026").
  const m = bruto.match(
    /(?<!\d)(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*(\d{4}|\d{2}))?(?!\d)/
  );
  // DDMMAAAA (8 dígitos) ou DDMMAA (6 dígitos), só se for a mensagem inteira.
  const compacto = bruto.match(/^(\d{2})(\d{2})(\d{4}|\d{2})$/);

  if (m) {
    dia = Number(m[1]);
    mes = Number(m[2]);
    if (m[3] === undefined) ano = null;
    else ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  } else if (compacto) {
    dia = Number(compacto[1]);
    mes = Number(compacto[2]);
    ano = compacto[3].length === 2 ? 2000 + Number(compacto[3]) : Number(compacto[3]);
  } else {
    return { ok: false, motivo: "formato" };
  }

  if (ano === null) {
    // Sem ano: usa o ano atual; se a data já passou, o próximo.
    ano = hoje.ano;
    if (
      calendarioValido(ano, mes, dia) &&
      numeroDoDia(ano, mes, dia) < numeroDoDia(hoje.ano, hoje.mes, hoje.dia)
    ) {
      ano += 1;
    }
  }

  if (mes < 1 || mes > 12 || dia < 1 || !calendarioValido(ano, mes, dia)) {
    return { ok: false, motivo: "formato" };
  }

  const diff =
    numeroDoDia(ano, mes, dia) - numeroDoDia(hoje.ano, hoje.mes, hoje.dia);
  if (diff < 0) return { ok: false, motivo: "passado" };
  if (diff < 1) return { ok: false, motivo: "proxima" };

  return { ok: true, data: `${p2(dia)}/${p2(mes)}/${ano}` };
}

export function dataAgendamentoValida(valor, agora = new Date()) {
  return analisarDataAgendamento(valor, agora).ok;
}

// Aceita 13:30, 9:30, 13h, 13h30, 13.30 e devolve "HH:MM", ou null.
export function normalizarHorario(valor) {
  const t = String(valor ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase();
  const m = t.match(/^(\d{1,2})\s*(?::|h|\.)\s*(\d{2})?\s*(?:h|hs|horas)?$/) ||
    t.match(/^(\d{1,2})\s*(?:h|hs|horas)$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${p2(h)}:${p2(min)}`;
}
