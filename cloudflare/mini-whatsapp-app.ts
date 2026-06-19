export const miniWhatsAppAppHtml = () => `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mini WhatsApp — Baileys DO</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07130f;
      --panel: #0d2119;
      --panel-2: #102b21;
      --border: #1e4b3a;
      --text: #e8fff4;
      --muted: #9ccab6;
      --accent: #35e58d;
      --danger: #ff6b6b;
      --warn: #ffd166;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top left, #164c36, var(--bg) 45%);
      color: var(--text);
    }
    header {
      padding: 20px;
      border-bottom: 1px solid var(--border);
      background: rgba(7, 19, 15, .8);
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(12px);
    }
    h1 { margin: 0 0 4px; font-size: 20px; }
    .sub { color: var(--muted); font-size: 13px; }
    main {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 16px;
      padding: 16px;
      max-width: 1500px;
      margin: 0 auto;
    }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
    .card {
      background: rgba(13, 33, 25, .86);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      box-shadow: 0 20px 50px rgba(0,0,0,.25);
    }
    .grid { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--border);
      background: #071812;
      color: var(--text);
      border-radius: 12px;
      padding: 10px 12px;
      outline: none;
    }
    textarea { min-height: 78px; resize: vertical; }
    input:focus, textarea:focus { border-color: var(--accent); }
    button {
      border: 0;
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--accent);
      color: #04110c;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary { background: #1c4032; color: var(--text); border: 1px solid var(--border); }
    button.danger { background: var(--danger); color: #1a0505; }
    button.warn { background: var(--warn); color: #181002; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .row > * { flex: 1; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: #071812;
      color: var(--muted);
      font-size: 13px;
    }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #6b7280; }
    .dot.ok { background: var(--accent); box-shadow: 0 0 16px var(--accent); }
    .dot.bad { background: var(--danger); box-shadow: 0 0 16px var(--danger); }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .tab { background: #0b1c15; color: var(--muted); border: 1px solid var(--border); }
    .tab.active { background: var(--accent); color: #04110c; }
    .list { display: grid; gap: 8px; max-height: 58vh; overflow: auto; padding-right: 4px; }
    .item {
      border: 1px solid var(--border);
      background: rgba(7,24,18,.72);
      border-radius: 14px;
      padding: 10px;
    }
    .item-title { font-weight: 700; word-break: break-all; }
    .item-meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .bubble {
      max-width: 780px;
      border: 1px solid var(--border);
      background: #0b1c15;
      border-radius: 16px;
      padding: 10px 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: #c8ffe1;
      font-size: 12px;
    }
    #qrCanvas {
      width: 240px;
      height: 240px;
      background: white;
      border-radius: 12px;
      padding: 8px;
      display: none;
    }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Mini WhatsApp — Baileys Durable Object</h1>
    <div class="sub">Painel de teste com token, WebSocket, QR, envio de mensagem e leitura do D1.</div>
  </header>

  <main>
    <section class="grid">
      <div class="card grid">
        <div class="row">
          <span class="status"><span id="dot" class="dot"></span><span id="statusText">desconectado</span></span>
        </div>
        <label>
          Token
          <input id="token" placeholder="BAILEYS_API_TOKEN" autocomplete="off" />
        </label>
        <label>
          Session ID
          <input id="session" value="main" />
        </label>
        <div class="row">
          <button id="connectBtn">Conectar WS</button>
          <button id="disconnectBtn" class="secondary">Desconectar</button>
        </div>
        <div class="row">
          <button id="startBtn">Start</button>
          <button id="statusBtn" class="secondary">Status</button>
          <button id="restartBtn" class="warn">Restart</button>
        </div>
        <div class="row">
          <button id="resetAuthBtn" class="danger">Reset Auth</button>
          <button id="resetAllBtn" class="danger">Reset All</button>
        </div>
      </div>

      <div class="card grid">
        <h3 style="margin:0">QR / Pareamento</h3>
        <canvas id="qrCanvas"></canvas>
        <textarea id="qrRaw" placeholder="QR raw aparece aqui" readonly></textarea>
        <div class="row">
          <button id="copyQrBtn" class="secondary">Copiar QR raw</button>
          <button id="clearQrBtn" class="secondary">Limpar QR</button>
        </div>
        <p class="muted small">No WhatsApp: Aparelhos conectados → Conectar aparelho. Se o canvas não renderizar, copie o QR raw e use um gerador externo.</p>
      </div>

      <div class="card grid">
        <h3 style="margin:0">Enviar mensagem</h3>
        <label>
          JID
          <input id="jid" placeholder="559999999999@s.whatsapp.net" />
        </label>
        <label>
          Texto
          <textarea id="messageText" placeholder="Mensagem de teste"></textarea>
        </label>
        <button id="sendBtn">Enviar</button>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <div class="tabs">
          <button class="tab active" data-tab="events">Eventos</button>
          <button class="tab" data-tab="messages">Mensagens D1</button>
          <button class="tab" data-tab="contacts">Contatos D1</button>
          <button class="tab" data-tab="chats">Chats D1</button>
        </div>

        <div id="eventsPanel" class="panel grid">
          <div class="row">
            <button id="clearEventsBtn" class="secondary">Limpar eventos</button>
            <button id="copyEventsBtn" class="secondary">Copiar eventos</button>
          </div>
          <div id="events" class="list"></div>
        </div>

        <div id="messagesPanel" class="panel grid" hidden>
          <div class="row">
            <button class="secondary" data-refresh="messages">Atualizar mensagens</button>
          </div>
          <div id="messages" class="list"></div>
        </div>

        <div id="contactsPanel" class="panel grid" hidden>
          <div class="row">
            <button class="secondary" data-refresh="contacts">Atualizar contatos</button>
          </div>
          <div id="contacts" class="list"></div>
        </div>

        <div id="chatsPanel" class="panel grid" hidden>
          <div class="row">
            <button class="secondary" data-refresh="chats">Atualizar chats</button>
          </div>
          <div id="chats" class="list"></div>
        </div>
      </div>
    </section>
  </main>

  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js"></script>
  <script>
    const $ = id => document.getElementById(id)
    const state = { ws: null, events: [] }

    const els = {
      token: $('token'), session: $('session'), dot: $('dot'), statusText: $('statusText'),
      qrCanvas: $('qrCanvas'), qrRaw: $('qrRaw'), events: $('events'),
      messages: $('messages'), contacts: $('contacts'), chats: $('chats'),
      jid: $('jid'), messageText: $('messageText')
    }

    els.token.value = localStorage.getItem('baileys.token') || ''
    els.session.value = localStorage.getItem('baileys.session') || 'main'
    els.jid.value = localStorage.getItem('baileys.lastJid') || ''

    function token() { return els.token.value.trim() }
    function sessionId() { return els.session.value.trim() || 'main' }
    function savePrefs() {
      localStorage.setItem('baileys.token', token())
      localStorage.setItem('baileys.session', sessionId())
      localStorage.setItem('baileys.lastJid', els.jid.value.trim())
    }
    function setStatus(text, kind) {
      els.statusText.textContent = text
      els.dot.className = 'dot ' + (kind || '')
    }
    function api(path) {
      const session = encodeURIComponent(sessionId())
      return '/session/' + session + path
    }
    async function apiFetch(path) {
      const res = await fetch(api(path), { headers: { Authorization: 'Bearer ' + token() } })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      if (!res.ok) throw new Error((body && body.error) || text || res.statusText)
      return body
    }
    function log(type, payload) {
      const entry = { at: new Date().toISOString(), type, payload }
      state.events.unshift(entry)
      state.events = state.events.slice(0, 300)
      renderEvents()
    }
    function renderEvents() {
      els.events.innerHTML = ''
      for (const entry of state.events) {
        const div = document.createElement('div')
        div.className = 'item'
        div.innerHTML = '<div class="item-title">' + escapeHtml(entry.type) + '</div><div class="item-meta">' + entry.at + '</div><pre>' + escapeHtml(JSON.stringify(entry.payload, null, 2)) + '</pre>'
        els.events.appendChild(div)
      }
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]))
    }
    function command(type, data = {}) {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket não conectado')
      const requestId = type + '-' + Date.now()
      state.ws.send(JSON.stringify({ type, requestId, ...data }))
      log('command.sent', { type, requestId, ...data })
    }
    async function renderQr(qr) {
      els.qrRaw.value = qr || ''
      if (!qr) {
        els.qrCanvas.style.display = 'none'
        return
      }
      if (window.QRCode && window.QRCode.toCanvas) {
        els.qrCanvas.style.display = 'block'
        await window.QRCode.toCanvas(els.qrCanvas, qr, { width: 240, margin: 1 })
      }
    }
    function connect() {
      savePrefs()
      if (!token()) return alert('Informe o token')
      if (state.ws) state.ws.close()
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = proto + '//' + location.host + '/session/' + encodeURIComponent(sessionId()) + '?token=' + encodeURIComponent(token())
      const ws = new WebSocket(url)
      state.ws = ws
      setStatus('conectando...', '')
      ws.onopen = () => { setStatus('WS conectado', 'ok'); log('ws.open', { url }) }
      ws.onclose = event => { setStatus('WS fechado', 'bad'); log('ws.close', { code: event.code, reason: event.reason }) }
      ws.onerror = event => { setStatus('WS erro', 'bad'); log('ws.error', { message: String(event?.message || 'erro') }) }
      ws.onmessage = async event => {
        let msg
        try { msg = JSON.parse(event.data) } catch { msg = event.data }
        log(msg.type || 'message', msg)
        if (msg.type === 'connection.update') {
          if (msg.update?.connection) setStatus('WA: ' + msg.update.connection, msg.update.connection === 'open' ? 'ok' : '')
          if (msg.update?.qr) await renderQr(msg.update.qr)
        }
        if (msg.type === 'messages.upsert') refreshStore('messages').catch(console.error)
      }
    }
    async function refreshStore(bucket) {
      const body = await apiFetch('/store/' + bucket + '?limit=80')
      const target = $(bucket)
      target.innerHTML = ''
      for (const entry of body.entries || []) {
        const value = entry.value || {}
        const title = bucket === 'messages'
          ? (value.key?.remoteJid || entry.id)
          : (value.name || value.notify || value.id || value.jid || entry.id)
        const text = bucket === 'messages'
          ? extractMessageText(value)
          : JSON.stringify(value, null, 2)
        const div = document.createElement('div')
        div.className = 'item'
        div.innerHTML = '<div class="item-title">' + escapeHtml(title) + '</div><div class="item-meta">' + escapeHtml(entry.id) + ' · ' + new Date(entry.updatedAt || Date.now()).toLocaleString() + '</div><div class="bubble">' + escapeHtml(text) + '</div>'
        target.appendChild(div)
      }
    }
    function extractMessageText(message) {
      const m = message.message || {}
      return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || JSON.stringify(m, null, 2)
    }

    $('connectBtn').onclick = connect
    $('disconnectBtn').onclick = () => state.ws?.close()
    $('startBtn').onclick = () => command('start')
    $('statusBtn').onclick = () => command('status')
    $('restartBtn').onclick = () => command('restart')
    $('resetAuthBtn').onclick = () => confirm('Resetar auth? Vai precisar parear de novo.') && command('reset-auth')
    $('resetAllBtn').onclick = () => confirm('Resetar auth + store?') && command('reset-all')
    $('sendBtn').onclick = () => {
      savePrefs()
      command('send-message', { jid: els.jid.value.trim(), text: els.messageText.value })
    }
    $('copyQrBtn').onclick = () => navigator.clipboard.writeText(els.qrRaw.value || '')
    $('clearQrBtn').onclick = () => renderQr('')
    $('clearEventsBtn').onclick = () => { state.events = []; renderEvents() }
    $('copyEventsBtn').onclick = () => navigator.clipboard.writeText(JSON.stringify(state.events, null, 2))

    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        document.querySelectorAll('.panel').forEach(p => p.hidden = true)
        $(btn.dataset.tab + 'Panel').hidden = false
      }
    })
    document.querySelectorAll('[data-refresh]').forEach(btn => {
      btn.onclick = () => refreshStore(btn.dataset.refresh).catch(error => log('refresh.error', { error: error.message }))
    })

    setStatus('desconectado', 'bad')
  </script>
</body>
</html>`

export const miniWhatsAppResponse = () =>
	new Response(miniWhatsAppAppHtml(), {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store'
		}
	})
