# Manual de teste — Baileys em Cloudflare Durable Object + D1

Este manual valida o fluxo completo:

```txt
Cliente do seu app
  -> WebSocket
Durable Object
  -> Baileys
  -> WebSocket outbound
WhatsApp Web
```

O objetivo é confirmar quatro coisas:

1. O Worker sobe localmente.
2. O Durable Object aceita WebSocket do seu app.
3. O auth state e o store são gravados no D1.
4. O restart interno funciona sem precisar matar o Worker/DO manualmente após autenticação.

> Este roteiro usa a branch `cloudflare-durable-object`.

---

## 0. Pré-requisitos

Você precisa ter:

- Node.js 20+.
- Conta Cloudflare logada no Wrangler.
- Um D1 database para deploy remoto.
- Um número/conta WhatsApp para parear.
- `npx` disponível.

Cheque login:

```bash
npx wrangler whoami
```

Se não estiver logado:

```bash
npx wrangler login
```

---

## 1. Baixar a branch do teste

```bash
git clone https://github.com/willfeerr/Baileys-Cloudflare-Compatible.git
cd Baileys-Cloudflare-Compatible
git checkout cloudflare-durable-object
```

Instale dependências:

```bash
yarn install
```

Se preferir npm, use:

```bash
npm install
```

---

## 2. Criar config do Wrangler

Copie o exemplo:

```bash
cp cloudflare/wrangler.example.jsonc cloudflare/wrangler.jsonc
```

Abra `cloudflare/wrangler.jsonc`.

Você verá algo assim:

```jsonc
{
  "name": "baileys-cloudflare-session",
  "main": "./baileys-session-do.ts",
  "compatibility_date": "2026-06-19",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "BAILEYS_SESSION",
        "class_name": "BaileysSessionDO"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["BaileysSessionDO"]
    }
  ],
  "d1_databases": [
    {
      "binding": "BAILEYS_D1",
      "database_name": "baileys_cloudflare",
      "database_id": "REPLACE_WITH_D1_DATABASE_ID"
    }
  ],
  "vars": {
    "BAILEYS_API_TOKEN": "dev-token-change-me"
  }
}
```

Para teste local, o `database_id` pode continuar temporariamente como placeholder, mas para deploy remoto ele precisa ser substituído pelo ID real do D1.

---

## 3. Criar D1 remoto

Crie o banco remoto:

```bash
npx wrangler d1 create baileys_cloudflare
```

O Wrangler vai imprimir um bloco parecido com:

```jsonc
{
  "binding": "DB",
  "database_name": "baileys_cloudflare",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

Copie o `database_id` e coloque em `cloudflare/wrangler.jsonc`:

```jsonc
"database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Mantenha o binding como:

```jsonc
"binding": "BAILEYS_D1"
```

---

## 4. Aplicar schema no D1 local

Rode:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --file cloudflare/schema.sql
```

Confirme se as tabelas existem localmente:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Você deve ver:

```txt
baileys_auth
baileys_store
```

---

## 5. Aplicar schema no D1 remoto

Rode:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --remote \
  --file cloudflare/schema.sql
```

Confirme remoto:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 6. Subir localmente

Em um terminal:

```bash
npx wrangler dev --config cloudflare/wrangler.jsonc
```

Você deve receber uma URL local parecida com:

```txt
http://127.0.0.1:8787
```

Guarde essa URL.

---

## 7. Smoke test HTTP local

Em outro terminal:

```bash
curl -i http://127.0.0.1:8787/session/main
```

Resultado esperado:

```json
{
  "ok": true,
  "sessionId": "main",
  "connected": false
}
```

Agora mande iniciar:

```bash
curl -i http://127.0.0.1:8787/session/main/start
```

Resultado esperado:

```json
{
  "ok": true,
  "sessionId": "main"
}
```

Se aparecer erro relacionado a `Unauthorized`, remova temporariamente `BAILEYS_API_TOKEN` do `wrangler.jsonc` para teste local ou envie header:

```bash
curl -i http://127.0.0.1:8787/session/main/start \
  -H "Authorization: Bearer dev-token-change-me"
```

---

## 8. Smoke test WebSocket local

Instale/use `wscat` sem salvar no projeto:

```bash
npx wscat -c ws://127.0.0.1:8787/session/main \
  -H "Authorization: Bearer dev-token-change-me"
```

Resultado esperado inicial:

```json
{"type":"hello","sessionId":"main"}
```

Envie comando de status:

```json
{"type":"status","requestId":"status-1"}
```

Resultado esperado:

```json
{"type":"command.result","requestId":"status-1","result":{"ok":true,"connected":false,"sessionId":"main"}}
```

Envie comando de start:

```json
{"type":"start","requestId":"start-1"}
```

Resultado esperado:

```json
{"type":"command.result","requestId":"start-1","result":{"ok":true}}
```

Em seguida você deve começar a receber eventos:

```json
{"type":"connection.update","sessionId":"main","update":{...}}
```

Se o Baileys emitir QR, o evento deve aparecer dentro de `connection.update.update.qr`.

---

## 9. Testar pareamento WhatsApp

Com o WebSocket aberto no `wscat`, observe eventos `connection.update`.

Procure por um payload com `qr`:

```json
{
  "type": "connection.update",
  "sessionId": "main",
  "update": {
    "qr": "..."
  }
}
```

Copie o valor de `qr` e gere um QR visual usando qualquer gerador local. Exemplo rápido com pacote temporário:

```bash
npx qrcode-terminal "COLE_AQUI_O_VALOR_DO_QR"
```

No WhatsApp:

```txt
WhatsApp > Aparelhos conectados > Conectar aparelho
```

Escaneie o QR.

Resultado esperado no WebSocket:

```json
{
  "type": "connection.update",
  "sessionId": "main",
  "update": {
    "connection": "open"
  }
}
```

---

## 10. Verificar se auth foi salvo no D1 local

Depois do QR/pairing, rode:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT key, updated_at FROM baileys_auth WHERE session_id='main' ORDER BY updated_at DESC LIMIT 20;"
```

Resultado esperado: linhas como:

```txt
creds
key:pre-key:...
key:session:...
key:app-state-sync-key:...
```

Se `creds` não apareceu, o `creds.update` não persistiu.

---

## 11. Testar restart sem matar o DO

Com o `wscat` aberto, envie:

```json
{"type":"restart","requestId":"restart-1"}
```

Resultado esperado:

```json
{"type":"command.result","requestId":"restart-1","result":{"ok":true}}
```

Depois disso, você deve receber:

```json
{"type":"baileys.restarted","sessionId":"main","reason":"client-command"}
```

E, se o auth state estiver correto, a sessão deve voltar sem novo QR:

```json
{"type":"connection.update","sessionId":"main","update":{"connection":"open"}}
```

Esse é o teste que valida o problema principal: não precisar matar o servidor/DO após autenticar.

---

## 12. Testar reset de auth

Para limpar só autenticação e Signal keys:

```json
{"type":"reset-auth","requestId":"reset-auth-1"}
```

Para limpar auth + store completo:

```json
{"type":"reset-all","requestId":"reset-all-1"}
```

Depois de `reset-auth` ou `reset-all`, o esperado é voltar a receber QR/pairing.

---

## 13. Testar envio de mensagem

Depois que `connection` estiver `open`, envie:

```json
{
  "type": "send-message",
  "requestId": "send-1",
  "jid": "559999999999@s.whatsapp.net",
  "text": "Teste via Cloudflare Durable Object"
}
```

Troque `559999999999` pelo número real com DDI + DDD + número.

Resultado esperado:

```json
{
  "type": "command.result",
  "requestId": "send-1",
  "result": {
    "ok": true,
    "result": { ... }
  }
}
```

---

## 14. Verificar store local

Mensagens:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT bucket, id, updated_at FROM baileys_store WHERE session_id='main' AND bucket='messages' ORDER BY updated_at DESC LIMIT 10;"
```

Contatos:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT bucket, id, updated_at FROM baileys_store WHERE session_id='main' AND bucket='contacts' ORDER BY updated_at DESC LIMIT 10;"
```

Chats:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT bucket, id, updated_at FROM baileys_store WHERE session_id='main' AND bucket='chats' ORDER BY updated_at DESC LIMIT 10;"
```

---

## 15. Deploy remoto

Depois que o local funcionar minimamente:

```bash
npx wrangler deploy --config cloudflare/wrangler.jsonc
```

O Wrangler deve retornar uma URL parecida com:

```txt
https://baileys-cloudflare-session.SEU_SUBDOMINIO.workers.dev
```

---

## 16. Smoke test HTTP remoto

```bash
curl -i https://baileys-cloudflare-session.SEU_SUBDOMINIO.workers.dev/session/main \
  -H "Authorization: Bearer dev-token-change-me"
```

Start remoto:

```bash
curl -i https://baileys-cloudflare-session.SEU_SUBDOMINIO.workers.dev/session/main/start \
  -H "Authorization: Bearer dev-token-change-me"
```

---

## 17. Smoke test WebSocket remoto

```bash
npx wscat -c wss://baileys-cloudflare-session.SEU_SUBDOMINIO.workers.dev/session/main \
  -H "Authorization: Bearer dev-token-change-me"
```

Envie:

```json
{"type":"status","requestId":"remote-status-1"}
```

Depois:

```json
{"type":"start","requestId":"remote-start-1"}
```

O fluxo esperado é o mesmo do local.

---

## 18. Verificar D1 remoto

Auth remoto:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --remote \
  --command "SELECT key, updated_at FROM baileys_auth WHERE session_id='main' ORDER BY updated_at DESC LIMIT 20;"
```

Store remoto:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --remote \
  --command "SELECT bucket, COUNT(*) as total FROM baileys_store WHERE session_id='main' GROUP BY bucket;"
```

---

## 19. Checklist do que precisa funcionar

Marque conforme testar:

- [ ] `wrangler dev` sobe sem erro.
- [ ] `GET /session/main` retorna JSON.
- [ ] `GET /session/main/start` inicia sem crash.
- [ ] `wscat` conecta em `/session/main`.
- [ ] WebSocket recebe `hello`.
- [ ] Comando `status` responde.
- [ ] Comando `start` responde.
- [ ] `connection.update` aparece no WebSocket.
- [ ] QR aparece no `connection.update`.
- [ ] WhatsApp pareia.
- [ ] `connection: "open"` aparece.
- [ ] D1 tem linha `creds` em `baileys_auth`.
- [ ] D1 tem Signal keys em `baileys_auth`.
- [ ] Comando `restart` funciona sem matar o Worker.
- [ ] Após `restart`, sessão volta sem QR.
- [ ] Comando `send-message` funciona.
- [ ] `baileys_store` recebe mensagens/contatos/chats.
- [ ] Deploy remoto sobe.
- [ ] WebSocket remoto funciona.
- [ ] D1 remoto recebe auth/store.

---

## 20. Erros prováveis e diagnóstico

### `Unauthorized`

Você está usando `BAILEYS_API_TOKEN` no `wrangler.jsonc`.

Use header:

```bash
-H "Authorization: Bearer dev-token-change-me"
```

Ou remova temporariamente a var `BAILEYS_API_TOKEN` em ambiente local.

---

### `no such table: baileys_auth` ou `no such table: baileys_store`

Rode o schema no ambiente certo.

Local:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --file cloudflare/schema.sql
```

Remoto:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --remote \
  --file cloudflare/schema.sql
```

---

### `WebSocket upgrade failed: 403`, `401`, `426` ou parecido

Isso provavelmente vem do WebSocket outbound do Baileys para o WhatsApp.

Verifique:

1. Se `nodejs_compat` está ativo.
2. Se o runtime local/remoto está permitindo outbound WebSocket.
3. Se o WhatsApp recusou headers/origin.
4. Se o QR/auth state antigo está inconsistente.

Tente:

```json
{"type":"reset-auth","requestId":"reset-auth-debug-1"}
```

Se persistir, tente:

```json
{"type":"reset-all","requestId":"reset-all-debug-1"}
```

---

### `connection.update` fecha com `restartRequired`

Esse caso é esperado no fluxo de autenticação do Baileys.

O DO deve agendar reconexão automática e mandar evento:

```json
{"type":"baileys.reconnect.scheduled", ...}
```

Se ele não voltar sozinho, envie:

```json
{"type":"restart","requestId":"manual-restart-after-auth"}
```

O esperado é voltar sem reiniciar `wrangler dev`.

---

### `creds` não aparece no D1

Cheque se `creds.update` foi emitido e se o schema existe.

Rode:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT session_id, key, updated_at FROM baileys_auth ORDER BY updated_at DESC LIMIT 20;"
```

Se não houver nada, o socket provavelmente não chegou até o fluxo de pairing.

---

### Mensagens não aparecem no `baileys_store`

O store só recebe eventos que o Baileys emitir.

Depois de conectar, envie/receba pelo menos uma mensagem e rode:

```bash
npx wrangler d1 execute baileys_cloudflare \
  --config cloudflare/wrangler.jsonc \
  --local \
  --command "SELECT bucket, COUNT(*) as total FROM baileys_store WHERE session_id='main' GROUP BY bucket;"
```

---

## 21. Logs úteis

Local:

```bash
npx wrangler dev --config cloudflare/wrangler.jsonc --log-level debug
```

Remoto:

```bash
npx wrangler tail baileys-cloudflare-session
```

---

## 22. Critério de sucesso mínimo

O teste é considerado bem-sucedido quando:

1. O cliente conecta no DO via WebSocket.
2. O DO inicia o Baileys.
3. O QR aparece no `connection.update`.
4. O WhatsApp pareia.
5. `creds` e Signal keys aparecem no D1.
6. O comando `restart` recria a sessão sem matar o Worker/DO.
7. A sessão volta para `connection: "open"` sem novo QR.
8. Uma mensagem pode ser enviada pelo comando `send-message`.

---

## 23. Próximos ajustes depois do primeiro teste

Depois que esse manual passar, os próximos pontos de produção são:

- Separar D1 local/dev/prod por ambiente.
- Trocar `BAILEYS_API_TOKEN` por secret real:

```bash
npx wrangler secret put BAILEYS_API_TOKEN --config cloudflare/wrangler.jsonc
```

- Criar retenção/limpeza para `baileys_store`.
- Adicionar paginação HTTP para ler mensagens/contatos/chats do D1.
- Adicionar endpoint para emitir QR já renderizado, se seu app não quiser gerar QR no frontend.
- Adicionar testes automatizados com Miniflare/Wrangler.
