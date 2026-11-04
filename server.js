import http from "node:http";
import crypto from "node:crypto";

const {
  WHATSAPP_TOKEN, PHONE_NUMBER_ID, APP_SECRET, VERIFY_TOKEN,
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
} = process.env;
const PORT = process.env.PORT || 8080;
const GRAPH = process.env.GRAPH_URL || "https://graph.facebook.com/v21.0";

const QR_MODE = process.env.WA_MODE === "qr";
const TIMEOUT_MS = 15000; // evita requisições penduradas (Supabase/Meta)
const MAX_BODY = 1024 * 1024; // 1 MB: limite de corpo nas rotas POST

// No modo QR (Baileys) a API da Meta não é usada; VERIFY_TOKEN protege a rota /qr.
const required = QR_MODE
  ? ["VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
  : ["WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "APP_SECRET", "VERIFY_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) console.warn("Variáveis ausentes:", missing.join(", "));

function validSignature(raw, header) {
  if (!APP_SECRET || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SB = () => ({
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
});
async function sb(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...SB(), ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) { console.error("Supabase", path, r.status, await r.text()); return null; }
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sendText(to, body) {
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) console.error("WhatsApp envio", r.status, await r.text());
  return r.ok ? (await r.json()).messages?.[0]?.id || true : false;
}

const MENU = "Olá! Sou o suporte virtual EMPIS. Como posso ajudar? Digite uma opção:\n1 - Abrir chamado\n2 - Consultar chamado (envie o protocolo)\n3 - Falar com um dos suportes (João Pedro ou Geliane)";
// Formato exigido pelo banco: EMPIS-AAAA-NNNNN; sequência por ano em contadores_protocolo
async function protocolo() {
  const ano = new Date().getFullYear();
  for (let i = 0; i < 5; i++) {
    const cur = (await sb(`contadores_protocolo?ano=eq.${ano}`))?.[0];
    if (!cur) {
      const c = await sb("contadores_protocolo", { method: "POST", prefer: "return=representation", body: { ano, ultimo: 1 } });
      if (c) return `EMPIS-${ano}-${String(1).padStart(5, "0")}`;
      continue;
    }
    const n = cur.ultimo + 1; // atualização condicional evita número repetido
    const up = await sb(`contadores_protocolo?ano=eq.${ano}&ultimo=eq.${cur.ultimo}`, { method: "PATCH", prefer: "return=representation", body: { ultimo: n } });
    if (up?.length) return `EMPIS-${ano}-${String(n).padStart(5, "0")}`;
  }
  return null;
}

async function getConversa(tel) {
  const r = await sb(`conversas?telefone=eq.${tel}&limit=1`);
  return r?.[0] || { telefone: tel, wa_id: tel, estado: "menu", dados: {}, bot_pausado: false };
}
const saveConversa = (c) => sb("conversas?on_conflict=telefone", {
  method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
  body: { ...c, atualizado_em: new Date().toISOString() },
});

function dataAgendamentoValida(valor) {
  const m = valor.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!m) return false;
  const [, dia, mes, ano] = m;
  const data = new Date(Number(ano), Number(mes) - 1, Number(dia));
  if (data.getFullYear() !== Number(ano) || data.getMonth() !== Number(mes) - 1 || data.getDate() !== Number(dia)) return false;
  const hoje = new Date();
  const amanha = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1);
  return data >= amanha;
}

function formatarDescricao(d) {
  const linhas = [
    d.categoria === "urgencia" ? "Solicitação de atendimento imediato" : "Solicitação de agendamento",
    `Equipamento: ${d.equipamento}`,
    `Quantidade: ${d.quantidade}`,
    `Sala: ${d.sala}`,
    `Horário: ${d.horario}`,
  ];
  if (d.data_agendamento) linhas.splice(4, 0, `Data de uso: ${d.data_agendamento}`);
  return linhas.join("\n").slice(0, 2000);
}

async function abrirChamado(c, dados) {
  const d = { ...c.dados, ...dados };
  let prof = (await sb(`professores?telefone=eq.${c.telefone}&limit=1`))?.[0];
  if (!prof) prof = (await sb("professores", { method: "POST", prefer: "return=representation",
    body: { nome: d.nome || "Não informado", telefone: c.telefone, consentimento_em: new Date().toISOString() } }))?.[0];
  if (!prof) return { texto: "Não consegui registrar agora. Tente novamente em instantes.", estado: "menu", dados: {} };
  const proto = await protocolo();
  if (!proto) return { texto: "Não consegui gerar o protocolo agora. Tente novamente.", estado: "menu", dados: {} };
  const ch = await sb("chamados", { method: "POST", prefer: "return=representation", body: {
    protocolo: proto, professor_id: prof.id, categoria: d.categoria,
    descricao: formatarDescricao(d), local: d.sala, urgencia: d.categoria === "urgencia" ? "imediata" : "agendada",
    status: "aberto", humano: false, chave_idempotencia: `${c.telefone}-${proto}`,
  } });
  if (!ch) return { texto: "Não consegui abrir o chamado agora. Tente novamente.", estado: "menu", dados: {} };
  const tipo = d.categoria === "urgencia" ? "urgente" : "agendado";
  return { texto: `Chamado ${tipo} aberto. Protocolo: ${proto}. Digite menu para voltar.`, estado: "menu", dados: {}, chamado_id: ch[0].id, protocolo: proto };
}

// devolve { texto, estado, dados }
async function fluxo(c, texto) {
  const t = texto.trim();
  const low = t.toLowerCase();
  if (["menu", "oi", "olá", "ola", "cancelar"].includes(low)) return { texto: MENU, estado: "menu", dados: {} };
  switch (c.estado) {
    case "nome":
      return { texto: "Escolha a categoria do chamado:\n1 - Urgência (atendimento imediato)\n2 - Agendamento (equipamento para uso em sala; solicite com pelo menos 1 dia de antecedência)", estado: "categoria", dados: { ...c.dados, nome: t } };
    case "categoria":
      if (!["1", "2", "urgência", "urgencia", "agendamento"].includes(low))
        return { texto: "Digite 1 para Urgência ou 2 para Agendamento.", estado: "categoria", dados: c.dados };
      return low === "1" || low === "urgência" || low === "urgencia"
        ? { texto: "Qual equipamento deseja?", estado: "equipamento", dados: { ...c.dados, categoria: "urgencia" } }
        : { texto: "Qual equipamento deseja agendar?", estado: "equipamento", dados: { ...c.dados, categoria: "agendamento" } };
    case "equipamento":
      return { texto: "Qual a quantidade?", estado: "quantidade", dados: { ...c.dados, equipamento: t } };
    case "quantidade":
      if (!/^\d+$/.test(t) || Number(t) < 1) return { texto: "Informe uma quantidade inteira maior que zero.", estado: "quantidade", dados: c.dados };
      return { texto: "Em qual sala será utilizado?", estado: "sala", dados: { ...c.dados, quantidade: Number(t) } };
    case "sala":
      return c.dados.categoria === "agendamento"
        ? { texto: "Para qual data será o uso? Informe no formato DD/MM/AAAA. O agendamento precisa ser feito com pelo menos 1 dia de antecedência.", estado: "data_agendamento", dados: { ...c.dados, sala: t } }
        : { texto: "Para qual horário precisa do equipamento?", estado: "horario", dados: { ...c.dados, sala: t } };
    case "data_agendamento":
      if (!dataAgendamentoValida(t)) return { texto: "A data deve estar no formato DD/MM/AAAA e ser, no mínimo, amanhã. Informe outra data.", estado: "data_agendamento", dados: c.dados };
      return { texto: "Para qual horário será o uso?", estado: "horario", dados: { ...c.dados, data_agendamento: t } };
    case "horario":
      return abrirChamado(c, { horario: t });
  }
  if (t === "1") {
    const prof = (await sb(`professores?telefone=eq.${c.telefone}&limit=1`))?.[0];
    return prof
      ? { texto: "Escolha a categoria do chamado:\n1 - Urgência (atendimento imediato)\n2 - Agendamento (equipamento para uso em sala; solicite com pelo menos 1 dia de antecedência)", estado: "categoria", dados: { nome: prof.nome } }
      : { texto: "Qual o seu nome? Ao continuar você concorda com o uso dos seus dados para atendimento.", estado: "nome", dados: {} };
  }
  if (t === "3") return { texto: "Certo! Um dos suportes (João Pedro ou Geliane) vai falar com você em breve.", estado: "menu", dados: {}, pausar: true };
  if (/^empis-\d{4}-\d{5}$/i.test(t) || t === "2") {
    if (t === "2") return { texto: "Envie o número do protocolo (ex: EMPIS-2026-00001).", estado: "menu", dados: {} };
    const ch = (await sb(`chamados?protocolo=eq.${t.toUpperCase()}&limit=1`))?.[0];
    return { texto: ch ? `Chamado ${ch.protocolo}: status ${ch.status}.` : "Protocolo não encontrado.", estado: "menu", dados: {} };
  }
  return { texto: MENU, estado: "menu", dados: {} };
}

async function handleMessage(m, send = sendText) {
  const tel = m.from;
  const texto = m.type === "text" ? m.text?.body : "";
  const dup = await sb(`mensagens?wamid=eq.${m.id}&select=id&limit=1`);
  if (dup?.length) return; // reentrega da Meta
  await sb("mensagens", { method: "POST", prefer: "return=minimal", body: {
    wamid: m.id, direcao: "entrada", remetente: tel, destinatario: PHONE_NUMBER_ID,
    conteudo: texto || `[${m.type}]`, tipo: m.type, enviada: true } });
  const c = await getConversa(tel);
  if (c.bot_pausado) return;
  const r = texto ? await fluxo(c, texto)
    : { texto: "Por enquanto só entendo mensagens de texto. Digite menu.", estado: c.estado, dados: c.dados };
  await saveConversa({ telefone: tel, wa_id: tel, estado: r.estado, dados: r.dados, bot_pausado: !!r.pausar });
  const id = await send(tel, r.texto);
  await sb("mensagens", { method: "POST", prefer: "return=minimal", body: {
    wamid: typeof id === "string" ? id : null, direcao: "saida", remetente: PHONE_NUMBER_ID, destinatario: tel,
    conteudo: r.texto, tipo: "text", protocolo: r.protocolo, chamado_id: r.chamado_id, enviada: !!id } });
}

import { readFileSync } from "node:fs";
// Baileys só é carregado no modo QR: no modo Meta o servidor sobe sem ele (menos memória e menos risco no boot).
let waState = { status: "desativado", qr: null, me: null };
if (QR_MODE) {
  try {
    const wa = await import("./wa.js");
    waState = wa.state; // mesmo objeto, atualizado pelo wa.js
    wa.startWhatsApp(handleMessage).catch((e) => console.error("WhatsApp", e));
  } catch (e) { console.error("Falha ao carregar o WhatsApp (Baileys). Rode npm ci e use Node >= 20.", e); }
}
const SIM = process.env.SIMULATOR === "1";
const simHtml = SIM ? readFileSync(new URL("./sim.html", import.meta.url), "utf8") : "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
    return res.writeHead(200, { "Content-Type": "application/json" }).end(req.method === "HEAD" ? undefined : '{"status":"ok"}');
  }
  if (QR_MODE && req.method === "GET" && url.pathname === "/qr") {
    if (url.searchParams.get("key") !== VERIFY_TOKEN) return res.writeHead(403).end("acesso negado");
    const body = waState.status === "conectado"
      ? `<h2>Conectado</h2><p>Número: ${String(waState.me).split(":")[0].split("@")[0]}</p>`
      : waState.qr ? `<h2>Escaneie com o WhatsApp</h2><p>Celular: Aparelhos conectados > Conectar um aparelho</p><img src="${waState.qr}">`
      : `<h2>${waState.status}</h2>`;
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><meta http-equiv=refresh content=5><body style="font-family:system-ui;text-align:center;padding:24px">${body}<p style="color:#888">Estado: ${waState.status}</p>`);
  }
  if (SIM && req.method === "GET" && (url.pathname === "/" || url.pathname === "/sim")) {
    return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(simHtml);
  }
  // Simulador: roda o mesmo fluxo e o mesmo banco, sem passar pela Meta. Só com SIMULATOR=1.
  if (SIM && req.method === "POST" && url.pathname === "/simulate") {
    let b = "", tooBig = false;
    req.on("data", (c) => { b += c; if (b.length > MAX_BODY) { tooBig = true; req.destroy(); } });
    req.on("end", async () => {
      if (tooBig) return;
      try {
        const { phone, text, reset } = JSON.parse(b);
        const tel = "5500" + String(phone || "0").replace(/\D/g, "").slice(-9).padStart(9, "0"); // 13 dígitos, prefixo 5500 = teste
        if (reset) {
          await sb(`mensagens?or=(remetente.eq.${tel},destinatario.eq.${tel})`, { method: "DELETE" });
          await sb(`conversas?telefone=eq.${tel}`, { method: "DELETE" });
          const p = (await sb(`professores?telefone=eq.${tel}&select=id`)) || [];
          for (const x of p) { await sb(`chamados?professor_id=eq.${x.id}`, { method: "DELETE" }); await sb(`professores?id=eq.${x.id}`, { method: "DELETE" }); }
          return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ replies: [] }));
        }
        const replies = [];
        await handleMessage({ from: tel, id: "wamid.sim" + crypto.randomUUID(), type: "text", text: { body: String(text || "") } },
          async (_to, t) => { replies.push(t); return "wamid.sim" + crypto.randomUUID(); });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ replies }));
      } catch (e) { res.writeHead(400).end(String(e.message)); }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/webhook") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      res.writeHead(200).end(url.searchParams.get("hub.challenge"));
    } else res.writeHead(403).end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; if (!res.headersSent) res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers["x-hub-signature-256"])) return res.writeHead(401).end();
      res.writeHead(200).end("ok"); // responde rápido; a Meta reenvia se demorar
      try {
        const body = JSON.parse(raw);
        for (const e of body.entry || []) for (const c of e.changes || [])
          for (const m of c.value?.messages || []) handleMessage(m).catch((err) => console.error(err));
      } catch (e) { console.error("payload inválido", e.message); }
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" }).end("WhatsApp chatbot online");
});
server.on("error", (e) => { console.error("Erro no servidor HTTP:", e); process.exit(1); });
server.listen(PORT, "0.0.0.0", () => console.log("ouvindo em", PORT));

export { server };
