// Conexão via WhatsApp Web (Baileys), sem a API da Meta. Não oficial.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

export const state = { status: "iniciando", qr: null, me: null };
let sock;

export async function startWhatsApp(onText) {
  const AUTH_DIR = process.env.AUTH_DIR || "./auth";
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  sock = makeWASocket({ auth, version, logger: pino({ level: "warn" }), browser: ["Suporte EMPIS", "Chrome", "1.0"], markOnlineOnConnect: false });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { state.status = "aguardando_qr"; state.qr = await QRCode.toDataURL(qr, { width: 320 }); }
    if (connection === "open") { state.status = "conectado"; state.qr = null; state.me = sock.user?.id; console.log("WhatsApp conectado:", state.me); }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.qr = null;
      if (code === DisconnectReason.loggedOut) {
        state.status = "desconectado (QR expirou ou sessão encerrada; reinicie para novo QR)";
        console.warn("Sessão encerrada no celular. Apague", AUTH_DIR, "e reinicie.");
      } else { state.status = "reconectando"; setTimeout(() => startWhatsApp(onText).catch(console.error), 3000); }
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      const jid = m.key.remoteJid || "";
      if (m.key.fromMe || !m.message || jid.endsWith("@g.us") || jid === "status@broadcast") continue;
      const real = jid.endsWith("@lid") ? (m.key.remoteJidAlt || jid) : jid;
      const from = real.split("@")[0].split(":")[0];
      const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
      const msg = { from, id: m.key.id, type: text ? "text" : "other", text: { body: text } };
      onText(msg, async (_to, body) => {
        const r = await sock.sendMessage(jid, { text: body });
        return r?.key?.id || true;
      }).catch((e) => console.error("erro msg", e));
    }
  });
}
