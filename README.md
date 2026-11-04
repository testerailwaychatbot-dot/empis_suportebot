# Suporte EMPIS – chatbot de suporte técnico (WhatsApp)

Servidor Node.js (ESM, sem framework) que atende professores pelo WhatsApp: abre chamados
(urgência ou agendamento de equipamento), consulta protocolo e transfere para um atendente humano.
Os dados ficam no Supabase (REST).

## Arquitetura

| Arquivo | Função |
|---|---|
| `src/railway-server.js` | **Ponto de entrada no Railway** (`npm start`). Diagnóstico de boot, tratamento de erros globais, desligamento gracioso (SIGTERM). Carrega o `server.js`. |
| `server.js` | Servidor HTTP, fluxo do chatbot, webhook da Meta, rotas `/health`, `/qr`, `/simulate`. A porta vem de `PORT`. |
| `wa.js` | Conexão alternativa via WhatsApp Web (Baileys). Só é carregado com `WA_MODE=qr`. |
| `sim.html` | Simulador de conversa no navegador (só com `SIMULATOR=1`). |
| `railway.json` | Comando de start e healthcheck (`/health`) no Railway. |
| `test/smoke.test.js` | Testes offline (`npm test`) com Supabase e Graph API falsos. |

### Dois modos de WhatsApp

- **Meta (padrão):** API oficial (Cloud API). A Meta chama `POST /webhook`; o bot responde pela Graph API.
- **QR (`WA_MODE=qr`):** Baileys (WhatsApp Web, **não oficial**; há risco de bloqueio do número). A sessão fica em `AUTH_DIR`.

## Variáveis de ambiente (Railway → serviço → Variables)

Nenhum valor está no código. Use o painel do Railway; nunca commite o `.env`.

| Variável | Meta | QR | Para quê |
|---|:-:|:-:|---|
| `VERIFY_TOKEN` | sim | sim | Texto que você inventa. Meta: verificação do webhook. QR: chave de acesso à página `/qr?key=...`. |
| `SUPABASE_URL` | sim | sim | URL do projeto Supabase. |
| `SUPABASE_SERVICE_KEY` | sim | sim | Chave `service_role` do Supabase (secreta; só no servidor). |
| `WHATSAPP_TOKEN` | sim | – | Token de acesso da Cloud API (Meta for Developers). |
| `PHONE_NUMBER_ID` | sim | – | ID do número na Cloud API. |
| `APP_SECRET` | sim | – | App Secret do app Meta (valida a assinatura `X-Hub-Signature-256`). |
| `WA_MODE` | – | `qr` | Ativa o modo Baileys. |
| `AUTH_DIR` | – | recomendado | Pasta da sessão. Sem Volume, a sessão se perde a cada deploy e é preciso ler o QR de novo. |
| `GRAPH_URL` | opcional | – | Padrão `https://graph.facebook.com/v21.0`. |
| `SIMULATOR` | **não usar** | **não usar** | `1` liga o simulador, sem autenticação, gravando no banco real. Só para testes locais. |
| `PORT` | automática | automática | O Railway define. **Não crie.** |

## Tabelas do Supabase usadas pelo código

O repositório não inclui o schema SQL. Pelo código, o banco precisa ter (colunas inferidas; confira no seu Supabase):

- `conversas`: `telefone` (único), `wa_id`, `estado`, `dados` (json), `bot_pausado`, `atualizado_em`
- `mensagens`: `wamid`, `direcao`, `remetente`, `destinatario`, `conteudo`, `tipo`, `enviada`, `protocolo`, `chamado_id`
- `professores`: `id`, `nome`, `telefone`, `consentimento_em`
- `chamados`: `id`, `protocolo`, `professor_id`, `categoria`, `descricao`, `local`, `urgencia`, `status`, `humano`, `chave_idempotencia`
- `contadores_protocolo`: `ano`, `ultimo`

## Deploy no Railway

1. Suba o código no GitHub (comandos abaixo). O Railway reimplanta a cada push.
2. No serviço, abra **Variables** e cadastre as variáveis da tabela acima.
3. Em **Settings → Networking**, clique em **Generate Domain** (o Railway não cria domínio público sozinho).
4. Em **Settings → Deploy**, se existir um *Custom Start Command* antigo, pode deixar vazio. O `railway.json` já define `node src/railway-server.js`.
5. Meta (modo Meta): em *WhatsApp → Configuration → Webhook*, use
   - Callback URL: `https://SEU-DOMINIO.up.railway.app/webhook`
   - Verify token: o mesmo valor de `VERIFY_TOKEN`
   - Assine o campo **messages**.

### Modo QR no Railway

Defina `WA_MODE=qr`, crie um **Volume** montado em, por exemplo, `/data` e defina `AUTH_DIR=/data/auth`
(confira no seu plano se Volumes estão disponíveis). Abra `https://SEU-DOMINIO.up.railway.app/qr?key=SEU_VERIFY_TOKEN`
e escaneie em *WhatsApp → Aparelhos conectados*.

## Como verificar se o deploy deu certo

1. **Deployments**: o último deploy fica *Active* (healthcheck `/health` aprovado).
2. **Deploy Logs** devem mostrar:
   ```
   [railway] Node 22.x | PORT=xxxx | modo=Meta (webhook) | simulador=desligado
   ouvindo em xxxx
   ```
   Se aparecer `Variáveis ausentes: ...`, cadastre as que o log lista.
3. Navegador ou `curl.exe`: `https://SEU-DOMINIO.up.railway.app/health` deve devolver `{"status":"ok"}`.
4. Verificação do webhook (deve devolver `teste`):
   `curl.exe "https://SEU-DOMINIO.up.railway.app/webhook?hub.mode=subscribe&hub.verify_token=SEU_VERIFY_TOKEN&hub.challenge=teste"`
5. Teste real: envie `oi` ao número do bot pelo WhatsApp. O bot deve responder o menu. Só considere o WhatsApp funcionando depois disso.

## Rodar localmente

Requer Node 20 ou superior.

```powershell
npm ci
npm test          # testes offline, sem credenciais
# execução real: copie .env.example para .env, preencha e carregue as variáveis no terminal
npm start
```

## Pontos de atenção

- `SIMULATOR=1` nunca em produção (rota `/simulate` sem autenticação).
- No modo QR, `PHONE_NUMBER_ID` não existe; o código o grava em `mensagens.remetente/destinatario`. Se essas colunas forem `NOT NULL`, o histórico de mensagens falhará (o atendimento continua e o erro aparece nos logs).
- O sistema de arquivos do Railway é efêmero: nada fora de um Volume sobrevive a um novo deploy.
