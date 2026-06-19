# E2E/TDD — Cloudflare Durable Object + D1

Este projeto agora tem um runner E2E para validar o Durable Object, D1, HTTP, WebSocket e, opcionalmente, o fluxo real do WhatsApp.

## Comando principal

```bash
yarn test:cloudflare
```

Ou com npm:

```bash
npm run test:cloudflare
```

Esse comando roda o smoke test local completo:

1. Verifica se os arquivos Cloudflare existem.
2. Aplica o schema local no D1.
3. Confirma as tabelas `baileys_auth` e `baileys_store`.
4. Sobe `wrangler dev` automaticamente.
5. Testa HTTP com e sem token.
6. Abre WebSocket no DO.
7. Valida evento `hello`.
8. Envia comando `status`.
9. Envia comando inválido e espera `command.error`.
10. Encerra o `wrangler dev` ao final.

Por padrão, esse smoke test **não conecta no WhatsApp**. Isso é intencional para ser rápido, repetível e estável em CI.

---

## Teste live com QR/pairing real

```bash
yarn test:cloudflare:live
```

Ou:

```bash
npm run test:cloudflare:live
```

Esse comando faz tudo do smoke test e depois:

1. Envia comando `start` para o DO.
2. Inicia o Baileys dentro do Durable Object.
3. Espera `connection.update`.
4. Se vier QR, imprime o QR raw e tenta renderizar no terminal com `qrcode-terminal` via `npx`.
5. Espera `connection: "open"`.
6. Confirma se `creds` foram persistidas no D1.
7. Envia comando `restart`.
8. Espera `baileys.restarted`.
9. Opcionalmente envia mensagem se `BAILEYS_E2E_SEND_JID` estiver definido.

Exemplo com envio de mensagem:

```bash
BAILEYS_E2E_SEND_JID="559999999999@s.whatsapp.net" \
BAILEYS_E2E_SEND_TEXT="Teste E2E Cloudflare" \
yarn test:cloudflare:live
```

---

## Testar Worker remoto já publicado

Defina a URL remota:

```bash
BAILEYS_E2E_BASE_URL="https://seu-worker.seu-subdominio.workers.dev" \
yarn test:cloudflare:remote
```

O teste remoto executa os mesmos smoke tests HTTP/WebSocket, mas não sobe `wrangler dev`.

---

## Deploy + teste remoto

```bash
BAILEYS_E2E_BASE_URL="https://seu-worker.seu-subdominio.workers.dev" \
yarn test:cloudflare:deploy
```

Esse comando:

1. Aplica o schema remoto no D1.
2. Roda `wrangler deploy`.
3. Testa a URL remota informada.

---

## Config de teste

O runner usa por padrão:

```txt
cloudflare/wrangler.test.jsonc
```

Essa config usa:

```jsonc
"BAILEYS_API_TOKEN": "test-token",
"BAILEYS_AUTO_START": "false"
```

`BAILEYS_AUTO_START=false` é importante para smoke test. Sem isso, abrir o WebSocket do cliente já iniciaria o Baileys e tentaria conectar no WhatsApp, tornando o teste instável.

---

## Variáveis úteis

### Porta local

```bash
BAILEYS_E2E_PORT=8798 yarn test:cloudflare
```

### Session ID fixo

```bash
BAILEYS_E2E_SESSION=main yarn test:cloudflare
```

### Token diferente

```bash
BAILEYS_E2E_TOKEN="outro-token" yarn test:cloudflare
```

### Config diferente

```bash
BAILEYS_E2E_CONFIG=cloudflare/wrangler.jsonc yarn test:cloudflare
```

### Timeout de pairing

```bash
BAILEYS_E2E_PAIRING_TIMEOUT_MS=300000 yarn test:cloudflare:live
```

---

## Critério TDD mínimo

Antes de mexer no DO, rode:

```bash
yarn test:cloudflare
```

Depois de qualquer mudança em WebSocket, D1, comandos ou roteamento, esse comando precisa continuar passando.

Quando alterar auth, QR, restart ou Baileys socket, rode:

```bash
yarn test:cloudflare:live
```

---

## Saída esperada do smoke test

Algo próximo de:

```txt
▶ preflight files
✓ preflight files

▶ apply D1 local schema
✓ apply D1 local schema

▶ assert D1 local tables
✓ assert D1 local tables

▶ start wrangler dev
✓ start wrangler dev

▶ HTTP smoke
✓ HTTP smoke

▶ WebSocket smoke
✓ WebSocket smoke

Smoke OK. Para testar QR/pairing real, rode com --live ou use yarn test:cloudflare:live.

✅ Cloudflare e2e concluído com sucesso.
```

---

## Arquivos envolvidos

- `scripts/cloudflare/e2e.mjs` — runner E2E.
- `cloudflare/wrangler.test.jsonc` — config local isolada de teste.
- `cloudflare/schema.sql` — schema D1.
- `cloudflare/baileys-session-do.ts` — Worker + Durable Object.
- `package.json` — scripts `test:cloudflare*`.
