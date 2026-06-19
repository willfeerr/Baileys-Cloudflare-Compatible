# Baileys on Cloudflare Durable Objects

This fork adds the first Cloudflare-compatible path for running Baileys inside a Durable Object while still exposing a WebSocket server to your application client.

## What changed

- `src/Socket/Client/websocket.ts` no longer statically imports `ws`.
- In Node.js, the client still uses `ws` through a dynamic import.
- In Cloudflare Workers / Durable Objects, the client uses `fetch(url, { headers: { Upgrade: 'websocket' } })`, reads `resp.webSocket`, sets `binaryType = 'arraybuffer'`, and calls `accept({ allowHalfOpen: true })`.
- `src/Cloudflare/useD1AuthState` stores credentials and Signal keys in D1.
- `src/Cloudflare/createD1BaileysStore` stores generic Baileys state buckets in D1: messages, contacts, chats, groups, media cache, retry cache, user devices cache, call offers, and placeholder resend cache.
- `cloudflare/baileys-session-do.ts` is an example Worker + Durable Object session server.

## Important architecture note

The Durable Object is the server WebSocket endpoint for your app client. Baileys is still a client WebSocket connection to WhatsApp Web.

So the flow is:

```txt
Your app client
  -> WebSocket
Cloudflare Durable Object
  -> outbound WebSocket
WhatsApp Web
```

This is intentional. The DO coordinates clients, stores session state, persists auth/store data in D1, and can restart the Baileys socket without restarting the whole Worker process.

## D1 schema

Run:

```bash
wrangler d1 execute baileys_cloudflare --file=cloudflare/schema.sql
```

The helper functions also run the default migration automatically unless you pass `autoMigrate: false`.

## Wrangler

Copy:

```bash
cp cloudflare/wrangler.example.jsonc cloudflare/wrangler.jsonc
```

Then replace:

```jsonc
"database_id": "REPLACE_WITH_D1_DATABASE_ID"
```

Use `nodejs_compat` because Baileys still relies on Node-compatible APIs such as Buffer, crypto, events, and util.

## Client WebSocket API

Connect from your app:

```ts
const ws = new WebSocket('wss://your-worker.example.workers.dev/session/main')

ws.onmessage = event => {
  console.log(JSON.parse(event.data))
}
```

Commands:

```ts
ws.send(JSON.stringify({ type: 'start', requestId: '1' }))
ws.send(JSON.stringify({ type: 'status', requestId: '2' }))
ws.send(JSON.stringify({ type: 'restart', requestId: '3' }))
ws.send(JSON.stringify({ type: 'reset-auth', requestId: '4' }))
ws.send(JSON.stringify({ type: 'reset-all', requestId: '5' }))
ws.send(JSON.stringify({
  type: 'send-message',
  requestId: '6',
  jid: '559999999999@s.whatsapp.net',
  text: 'Hello from Cloudflare DO'
}))
```

Events pushed by the DO:

```ts
{ type: 'hello', sessionId: 'main' }
{ type: 'connection.update', sessionId: 'main', update: { ... } }
{ type: 'messages.upsert', sessionId: 'main', event: { ... } }
{ type: 'baileys.reconnect.scheduled', sessionId: 'main', reconnectAt: 123 }
{ type: 'baileys.restarted', sessionId: 'main', reason: 'alarm' }
```

## Fix for the “need to kill the server after auth” problem

The example DO handles this in-process:

1. `creds.update` is persisted to D1 immediately.
2. When Baileys closes with `DisconnectReason.restartRequired`, the DO schedules a near-immediate reconnect.
3. When Baileys closes for another non-logout reason, the DO schedules reconnect with exponential backoff.
4. The `restart` command closes the current socket and starts a fresh Baileys instance inside the same Durable Object.
5. `reset-auth` clears only auth/signal keys.
6. `reset-all` clears auth plus the generic store.

That means pairing/authentication should not require manually killing the Worker or restarting the DO. The session is recreated from D1.

## Current limitations

This is the first Cloudflare-compatible layer, not a final production hardening pass.

- Outbound WebSocket to WhatsApp keeps the DO active while connected. Hibernation is mainly useful for your app clients connected to the DO, not for the WhatsApp outbound socket itself.
- The example stores full event payloads in D1 as JSON. For high-volume production, add retention, pagination, compression, and per-bucket cleanup policies.
- The example assumes one Durable Object per WhatsApp session ID.
- You still need to test the WhatsApp auth flow end-to-end with your Worker route and D1 database.
