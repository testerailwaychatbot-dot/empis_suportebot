// Conexão via WhatsApp Web (Baileys), sem a API da Meta. Não oficial.
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

export const state = { status: "iniciando", qr: null, me: null };
let sock;
let iniciando = false;

export async function startWhatsApp(onText) {
  if (iniciando) return;
  iniciando = true;

  const AUTH_DIR = process.env.AUTH_DIR || "./auth";

  try {
    const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));

    sock = makeWASocket({
      auth,
      ...(version ? { version } : {}),
      logger: pino({ level: "warn" }),
      browser: ["Suporte EMPIS", "Chrome", "1.0"],
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.status = "aguardando_qr";
        state.qr = await QRCode.toDataURL(qr, { width: 320 });
      }

      if (connection === "open") {
        state.status = "conectado";
        state.qr = null;
        state.me = sock.user?.id || null;
        console.log("WhatsApp conectado:", state.me);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        state.qr = null;
        iniciando = false;

        if (code === DisconnectReason.loggedOut) {
          state.status = "desconectado";
          console.warn(
            "Sessão encerrada no celular. Para gerar um novo QR Code, encerre o servidor, apague a pasta auth e reinicie."
          );
        } else {
          state.status = "reconectando";
          setTimeout(() => {
            startWhatsApp(onText).catch((error) =>
              console.error("Erro ao reconectar WhatsApp:", error)
            );
          }, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const mensagem of messages) {
        const jid = mensagem.key?.remoteJid || "";

        if (
          mensagem.key?.fromMe ||
          !mensagem.message ||
          jid.endsWith("@g.us") ||
          jid === "status@broadcast"
        ) {
          continue;
        }

        const real = jid.endsWith("@lid")
          ? mensagem.key?.remoteJidAlt || jid
          : jid;
        const from = real.split("@")[0].split(":")[0];
        const texto =
          mensagem.message.conversation ||
          mensagem.message.extendedTextMessage?.text ||
          mensagem.message.imageMessage?.caption ||
          mensagem.message.videoMessage?.caption ||
          "";

        const msg = {
          from,
          id: mensagem.key?.id,
          type: texto ? "text" : "other",
          text: { body: texto },
        };

        onText(msg, async (_to, body) => {
          if (!sock) throw new Error("WhatsApp não está conectado.");
          const enviado = await sock.sendMessage(jid, { text: body });
          return enviado?.key?.id || true;
        }).catch((error) => console.error("Erro ao processar mensagem:", error));
      }
    });
  } catch (error) {
    iniciando = false;
    state.status = "erro ao iniciar";
    console.error("Falha ao iniciar WhatsApp:", error);
    throw error;
  }
}
