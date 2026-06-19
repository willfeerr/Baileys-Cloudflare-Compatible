# Mini WhatsApp de teste

O Worker agora serve um painel HTML simples para testar o Durable Object sem Postman, Insomnia ou `wscat`.

## Abrir localmente

Suba o Worker:

```bash
yarn test:cloudflare
```

Ou, se quiser manter o Worker aberto manualmente:

```bash
npx wrangler dev --config cloudflare/wrangler.test.jsonc
```

Abra:

```txt
http://127.0.0.1:8797/app
```

Na config de teste, o token padrão é:

```txt
test-token
```

## Abrir em deploy

Depois do deploy:

```txt
https://SEU_WORKER.workers.dev/app
```

Informe o token configurado em `BAILEYS_API_TOKEN`.

## Por que token por query string?

Browsers não permitem setar header `Authorization` manualmente no construtor nativo de `WebSocket`.

Por isso o Worker aceita as duas formas:

```http
Authorization: Bearer TOKEN
```

ou:

```txt
/session/main?token=TOKEN
```

A UI usa `?token=` apenas no WebSocket. Para `fetch`, ela envia `Authorization: Bearer TOKEN`.

## O que a UI faz

A tela `/app` permite:

- Informar token e session ID.
- Conectar/desconectar WebSocket.
- Enviar comandos `start`, `status`, `restart`, `reset-auth`, `reset-all`.
- Ver eventos em tempo real.
- Renderizar QR via canvas quando possível.
- Copiar QR raw.
- Enviar mensagem por JID.
- Ler do D1 os buckets:
  - `messages`
  - `contacts`
  - `chats`

## Endpoint de store usado pela UI

A UI lê dados persistidos em D1 por:

```txt
GET /session/:sessionId/store/:bucket?limit=80
```

Exemplos:

```bash
curl "http://127.0.0.1:8797/session/main/store/messages?limit=20" \
  -H "Authorization: Bearer test-token"
```

```bash
curl "http://127.0.0.1:8797/session/main/store/contacts?limit=20" \
  -H "Authorization: Bearer test-token"
```

Buckets permitidos no endpoint:

- `messages`
- `contacts`
- `chats`
- `groups`
- `media`
- `msg-retry`
- `user-devices`

## Teste automático

O comando abaixo agora também valida se `/app` carrega e se `/session/:id/store/messages` responde:

```bash
yarn test:cloudflare
```

Para testar o fluxo real de WhatsApp com QR:

```bash
yarn test:cloudflare:live
```
