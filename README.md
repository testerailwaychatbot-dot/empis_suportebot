# Suporte EMPIS – chatbot de suporte técnico (WhatsApp)

Servidor Node.js (ESM, sem framework) que atende professores pelo WhatsApp: abre chamados
(urgência ou agendamento de equipamento), consulta protocolo e transfere para um atendente humano.
Os dados ficam no Supabase (REST).

## Arquitetura

| Arquivo | Função |
| --- | --- |
| `src/railway-server.js` | **Ponto de entrada no Railway** (`npm start`). Diagnóstico de boot, tratamento de erros globais, desligamento gracioso (SIGTERM). Carrega o `server.js`. |
| `server.js` | Servidor HTTP, fluxo do chatbot, webhook da Meta, rotas `/health`, `/qr`, `/simulate`. A porta vem de `PORT`. |
| `wa.js` | Conexão alternativa via WhatsApp Web (Baileys). Só é carregado com `WA_MODE=qr`. |
| `sim.html` | Simulador de conversa no navegador (só com `SIMULATOR=1`). |
| `railway.json` | Comando de start e healthcheck (`/health`) no Railway. |
| `test/smoke.test.js` | Testes offline (`npm test`) com Supabase e Graph API falsos. |

### Dois modos de WhatsApp

- **Meta (padrão):** API oficial (Cloud API). A Meta chama `POST /webhook`; o bot responde pela Graph API.

- **QR (****`WA_MODE=qr`****):** Baileys (WhatsApp Web, **não oficial**; há risco de bloqueio do número). A sessão fica em `AUTH_DIR`.

## Variáveis de ambiente (Railway → serviço → Variables)

Nenhum valor está no código. Use o painel do Railway; nunca commite o `.env`.

| Variável | Meta | QR | Para quê |
| --- | --- | --- | --- |
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

1. No serviço, abra **Variables** e cadastre as variáveis da tabela acima.

1. Em **Settings → Networking**, clique em **Generate Domain** (o Railway não cria domínio público sozinho).

1. Em **Settings → Deploy**, se existir um *Custom Start Command* antigo, pode deixar vazio. O `railway.json` já define `node src/railway-server.js`.

1. Meta (modo Meta): em *WhatsApp → Configuration → Webhook*, use
  - Callback URL: `https://SEU-DOMINIO.up.railway.app/webhook`
  - Verify token: o mesmo valor de `VERIFY_TOKEN`
  - Assine o campo **messages**.

### Modo QR no Railway

Defina `WA_MODE=qr`, crie um **Volume** montado em, por exemplo, `/data` e defina `AUTH_DIR=/data/auth`
(confira no seu plano se Volumes estão disponíveis). Abra `https://SEU-DOMINIO.up.railway.app/qr?key=SEU_VERIFY_TOKEN`
e escaneie em *WhatsApp → Aparelhos conectados*.

## Como verificar se o deploy deu certo

1. **Deployments**: o último deploy fica *Active* (healthcheck `/health` aprovado).

1. **Deploy Logs** devem mostrar:

   ```
   [railway] Node 22.x | PORT=xxxx | modo=Meta (webhook) | simulador=desligado
   ouvindo em xxxx
   ```

   Se aparecer `Variáveis ausentes: ...`, cadastre as que o log lista.

1. Navegador ou `curl.exe`: `https://SEU-DOMINIO.up.railway.app/health` deve devolver `{"status":"ok"}`.

1. Verificação do webhook (deve devolver `teste`):
`curl.exe "https://SEU-DOMINIO.up.railway.app/webhook?hub.mode=subscribe&hub.verify_token=SEU_VERIFY_TOKEN&hub.challenge=teste"`

1. Teste real: envie `oi` ao número do bot pelo WhatsApp. O bot deve responder o menu. Só considere o WhatsApp funcionando depois disso.

## Rodar localmente

Requer Node 20 ou superior.

```
npm ci
npm test          # testes offline, sem credenciais
# execução real: copie .env.example para .env, preencha e carregue as variáveis no terminal
npm start
```

## Pontos de atenção

- `SIMULATOR=1` nunca em produção (rota `/simulate` sem autenticação).

- No modo QR, `PHONE_NUMBER_ID` não existe; o código o grava em `mensagens.remetente/destinatario`. Se essas colunas forem `NOT NULL`, o histórico de mensagens falhará (o atendimento continua e o erro aparece nos logs).

- O sistema de arquivos do Railway é efêmero: nada fora de um Volume sobrevive a um novo deploy.

## Integração com Google Agenda

Quando ativada, a integração consulta o Google Calendar antes de registrar um agendamento. Se o horário estiver ocupado, o chatbot pede outro horário. Depois que o chamado é criado, um evento é inserido na agenda com equipamento, sala, quantidade, telefone e protocolo.

A integração usa uma conta de serviço do Google. No Google Cloud Console:

1. Crie ou selecione um projeto.

1. Ative a **Google Calendar API** em *APIs e serviços → Biblioteca*.

1. Crie uma **Service Account** em *IAM e administração → Contas de serviço* e gere uma chave JSON.

1. Abra o Google Calendar que será usado, vá em **Configurações e compartilhamento → Compartilhar com pessoas e grupos** e compartilhe com o e-mail `client_email` da conta de serviço, com permissão **Fazer alterações nos eventos**.

1. Copie o ID da agenda em **Configurações e compartilhamento → Integrar agenda → ID da agenda**. Em uma agenda comum ele costuma terminar em `@group.calendar.google.com`; não confunda com o e-mail da conta de serviço.

No Railway, adicione estas variáveis em **Variables**:

| Variável | Valor |
| --- | --- |
| `GOOGLE_CALENDAR_ENABLED` | `true` |
| `GOOGLE_CALENDAR_ID` | ID da agenda compartilhada |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | conteúdo inteiro do JSON da chave, em uma única linha |
| `GOOGLE_CALENDAR_TIME_ZONE` | `America/Sao_Paulo` |
| `GOOGLE_CALENDAR_DURATION_MINUTES` | duração reservada; padrão `60` |

No `GOOGLE_SERVICE_ACCOUNT_JSON`, cole o JSON inteiro sem aspas extras. Nunca envie a chave para o GitHub nem coloque esse valor no `.env` versionado. O código aceita os `\\n` presentes na chave privada JSON.

Se o Google Calendar não estiver configurado, o chatbot continua funcionando e registra o chamado normalmente. Se a agenda estiver configurada, mas ocorrer uma falha temporária ao criar o evento, o chamado também é preservado e o bot avisa que a sincronização precisa ser conferida.

## Como atualizar no GitHub e testar

Depois de baixar a versão alterada, entre na pasta do projeto e execute:

```bash
npm ci
npm test
git status
git add calendar.js server.js package.json package-lock.json .env.example README.md
git commit -m "Integra Google Agenda aos agendamentos"
git push origin main
```

Se a branch principal do seu repositório for `master`, troque `main` por `master`. Não faça `git add .env` e confirme que a chave JSON não aparece no `git diff`.

O Railway deve iniciar um novo deploy após o `git push`. Depois que ele ficar **Active**, teste:

```bash
curl https://SEU-DOMINIO.up.railway.app/health
```

O retorno esperado é `{"status":"ok"}`. Em seguida, envie uma mensagem ao WhatsApp do bot, escolha **2 - Agendamento** e informe equipamento, quantidade, sala, uma data a partir de amanhã e um horário. Confirme no Google Calendar se o evento foi criado com o protocolo e a sala. Para testar conflito, repita o mesmo horário: o bot deve informar que ele já está ocupado e pedir outro.

Para testar localmente, use Node 20 ou superior, configure as variáveis do `.env` no terminal e rode `npm start`. Não deixe `SIMULATOR=1` em produção. O teste automatizado disponível pode ser executado com `npm test`; ele valida as regras de data e horário sem acessar o Google, o Supabase ou o WhatsApp.
