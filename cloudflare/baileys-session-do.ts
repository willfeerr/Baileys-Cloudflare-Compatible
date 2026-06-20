import makeWASocket, {
	BufferJSON,
	DisconnectReason,
	createD1BaileysStore,
	type BaileysEventMap,
	type D1Database,
	type WAMessage,
	useD1AuthState
} from '../src/index'
import { miniWhatsAppResponse } from './mini-whatsapp-app'
import { toString as qrToString } from 'qrcode'

export interface Env {
	BAILEYS_SESSION: DurableObjectNamespace
	BAILEYS_D1: D1Database
	BAILEYS_API_TOKEN?: string
	BAILEYS_INBOUND_WEBHOOK_URL?: string
	BAILEYS_INBOUND_WEBHOOK_SECRET?: string
	/** Set to false/0/no/off to keep WebSocket smoke tests from connecting to WhatsApp automatically. */
	BAILEYS_AUTO_START?: string
}

type WASocket = ReturnType<typeof makeWASocket>
type MessageUpsertEvent = BaileysEventMap['messages.upsert']
type ConnectionUpdateEvent = BaileysEventMap['connection.update']

type SessionSnapshot = {
	connected: boolean
	qrCode?: string
	sessionId: string
	status: string
	success: true
	updatedAt: string
	user?: {
		id?: string
		name?: string
	}
}

type ClientCommand = {
	type: 'start' | 'status' | 'restart' | 'logout' | 'reset-auth' | 'reset-all' | 'send-message'
	requestId?: string
	jid?: string
	text?: string
	message?: Record<string, unknown>
}

const SESSION_SNAPSHOT_KEY = 'session:snapshot'

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	})

const getStatusCode = (error: unknown): number | undefined => {
	return (error as any)?.output?.statusCode || (error as any)?.statusCode
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const isDisabled = (value: string | undefined) =>
	['false', '0', 'no', 'off'].includes(String(value || '').toLowerCase())

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const firstString = (...values: unknown[]) => {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim()
		}
	}
}

const readJsonObject = async (request: Request): Promise<Record<string, unknown>> => {
	const value = await request.json().catch(() => ({}))
	return isRecord(value) ? value : {}
}

type ConsoleMethod = (...data: unknown[]) => void

let libsignalLogRedactionInstalled = false

const redactLibsignalSessionPayload = (method: ConsoleMethod, redactedMessages: ReadonlySet<string>): ConsoleMethod => {
	return (first: unknown, ...rest: unknown[]) => {
		if (typeof first === 'string' && redactedMessages.has(first)) {
			method(first.replace(/:$/, ''))
			return
		}

		method(first, ...rest)
	}
}

const installLibsignalLogRedaction = () => {
	if (libsignalLogRedactionInstalled) {
		return
	}

	libsignalLogRedactionInstalled = true
	console.info = redactLibsignalSessionPayload(
		console.info.bind(console),
		new Set(['Closing session:', 'Opening session:'])
	)
	console.warn = redactLibsignalSessionPayload(console.warn.bind(console), new Set(['Session already closed']))
}

const readToken = (request: Request) => {
	const url = new URL(request.url)
	return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || ''
}

const assertAuthorized = (request: Request, env: Env) => {
	if (!env.BAILEYS_API_TOKEN) {
		return null
	}

	const token = readToken(request)
	if (token !== env.BAILEYS_API_TOKEN) {
		return json({ ok: false, error: 'Unauthorized' }, 401)
	}

	return null
}

const qrResponse = async (request: Request, env: Env) => {
	const unauthorized = assertAuthorized(request, env)
	if (unauthorized) {
		return unauthorized
	}

	const url = new URL(request.url)
	const data = url.searchParams.get('data') || ''
	if (!data) {
		return json({ ok: false, error: 'Missing QR data' }, 400)
	}

	const svg = await qrToString(data, {
		type: 'svg',
		errorCorrectionLevel: 'M',
		margin: 4,
		width: 720
	})

	return new Response(svg, {
		headers: {
			'content-type': 'image/svg+xml; charset=utf-8',
			'cache-control': 'no-store'
		}
	})
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const [, route, sessionId = 'default'] = url.pathname.split('/')

		if (route === '' || route === 'app') {
			return miniWhatsAppResponse()
		}

		if (route === 'qr') {
			return qrResponse(request, env)
		}

		if (route !== 'session') {
			return json({ ok: false, error: 'Use /app, /qr, or /session/:sessionId' }, 404)
		}

		const unauthorized = assertAuthorized(request, env)
		if (unauthorized) {
			return unauthorized
		}

		const id = env.BAILEYS_SESSION.idFromName(sessionId)
		return env.BAILEYS_SESSION.get(id).fetch(request)
	}
}

export class BaileysSessionDO {
	private sock: WASocket | null = null
	private startPromise: Promise<WASocket> | null = null
	private restartPromise: Promise<void> | null = null
	private reconnectAttempts = 0
	private sessionId = 'default'

	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env
	) {}

	async fetch(request: Request): Promise<Response> {
		this.sessionId = await this.resolveSessionId(request)

		if (request.headers.get('Upgrade') === 'websocket') {
			return this.acceptClientWebSocket(request)
		}

		const url = new URL(request.url)
		const segments = url.pathname.split('/').filter(Boolean)
		const action = segments[2]

		if (action === 'store') {
			const bucket = segments[3]
			return this.readStoreBucket(bucket, url)
		}

		if ((action === 'send-message' || action === 'reply-message') && request.method === 'POST') {
			return this.handleHttpSendMessage(request)
		}

		if (url.pathname.endsWith('/start')) {
			await this.startBaileys()
			return json(await this.getSessionSnapshot())
		}

		if (url.pathname.endsWith('/restart')) {
			await this.restartBaileys('http-command')
			return json(await this.getSessionSnapshot())
		}

		if (url.pathname.endsWith('/reset-auth')) {
			await this.resetAuth(false)
			return json(await this.getSessionSnapshot())
		}

		return json(await this.getSessionSnapshot())
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		try {
			const command = this.parseCommand(message)
			const result = await this.handleCommand(command)
			this.send(ws, { type: 'command.result', requestId: command.requestId, result })
		} catch (error) {
			this.send(ws, { type: 'command.error', error: String((error as Error)?.message || error) })
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code, reason)
		} catch {}
	}

	async alarm() {
		await this.restartBaileys('alarm')
	}

	private async acceptClientWebSocket(request: Request): Promise<Response> {
		const pair = new (globalThis as any).WebSocketPair()
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

		server.serializeAttachment?.({ sessionId: this.sessionId, connectedAt: Date.now() })
		this.state.acceptWebSocket(server)
		this.send(server, { type: 'hello', sessionId: this.sessionId })

		if (this.shouldAutoStart()) {
			void this.startBaileys().catch(error => {
				this.broadcast({ type: 'baileys.start.error', error: String(error?.message || error) })
			})
		}

		return new Response(null, { status: 101, webSocket: client })
	}

	private shouldAutoStart() {
		return !isDisabled(this.env.BAILEYS_AUTO_START)
	}

	private async readStoreBucket(bucket: string | undefined, url: URL) {
		const allowed = new Set(['messages', 'contacts', 'chats', 'groups', 'media', 'msg-retry', 'user-devices'])
		if (!bucket || !allowed.has(bucket)) {
			return json({ ok: false, error: 'Invalid store bucket' }, 400)
		}

		const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 80), 1), 500)
		const afterUpdatedAt = Number(url.searchParams.get('afterUpdatedAt') || 0)
		const store = await createD1BaileysStore(this.env.BAILEYS_D1, { sessionId: this.sessionId })
		const entries = await store.list(bucket, { limit, afterUpdatedAt })

		return json({ ok: true, sessionId: this.sessionId, bucket, entries })
	}

	private async handleHttpSendMessage(request: Request) {
		try {
			const body = await readJsonObject(request)
			const result = await this.sendMessageFromBody(body)
			const messageId = result?.key?.id

			return json({
				ok: true,
				success: true,
				sessionId: this.sessionId,
				conversationId: result?.key?.remoteJid,
				messageIds: messageId ? [messageId] : [],
				result
			})
		} catch (error) {
			return json({ ok: false, success: false, error: String((error as Error)?.message || error) }, 400)
		}
	}

	private async resolveSessionId(request?: Request): Promise<string> {
		if (request) {
			const url = new URL(request.url)
			const [, route, sessionId = 'default'] = url.pathname.split('/')
			if (route === 'session') {
				await this.state.storage.put('sessionId', sessionId)
				return sessionId
			}
		}

		return (await this.state.storage.get<string>('sessionId')) || 'default'
	}

	private async readSessionSnapshot(): Promise<SessionSnapshot | undefined> {
		return this.state.storage.get<SessionSnapshot>(SESSION_SNAPSHOT_KEY)
	}

	private async getSessionSnapshot(): Promise<SessionSnapshot> {
		const saved = await this.readSessionSnapshot()
		const runtimeConnected = Boolean(this.sock?.ws?.isOpen)
		const connected = runtimeConnected || saved?.connected === true
		const status = connected ? 'connected' : saved?.status || 'idle'

		return {
			connected,
			qrCode: connected ? undefined : saved?.qrCode,
			sessionId: this.sessionId,
			status,
			success: true,
			updatedAt: saved?.updatedAt || new Date().toISOString(),
			user: saved?.user
		}
	}

	private async persistConnectionUpdate(update: ConnectionUpdateEvent, sock: WASocket) {
		const saved = await this.readSessionSnapshot()
		const qrCode = firstString(update.qr)
		const connection = firstString(update.connection)
		const connected = connection === 'open' || Boolean(sock.ws?.isOpen)
		const status =
			qrCode ? 'qr' : connected ? 'connected' : connection === 'connecting' ? 'connecting' : connection === 'close' ? 'disconnected' : saved?.status || 'idle'
		const user = isRecord(sock.user)
			? {
					id: firstString(sock.user.id),
					name: firstString(sock.user.name)
				}
			: saved?.user

		await this.state.storage.put<SessionSnapshot>(SESSION_SNAPSHOT_KEY, {
			connected,
			qrCode: connected ? undefined : qrCode || saved?.qrCode,
			sessionId: this.sessionId,
			status,
			success: true,
			updatedAt: new Date().toISOString(),
			user
		})
	}

	private async startBaileys(): Promise<WASocket> {
		if (this.sock) return this.sock
		if (this.startPromise) return this.startPromise

		this.startPromise = this.createBaileysSocket()
			.then(sock => {
				this.sock = sock
				return sock
			})
			.finally(() => {
				this.startPromise = null
			})

		return this.startPromise
	}

	private async createBaileysSocket(): Promise<WASocket> {
		installLibsignalLogRedaction()

		const auth = await useD1AuthState(this.env.BAILEYS_D1, { sessionId: this.sessionId })
		const store = await createD1BaileysStore(this.env.BAILEYS_D1, { sessionId: this.sessionId })

		const sock = makeWASocket({
			auth: auth.state,
			printQRInTerminal: false,
			syncFullHistory: false,
			msgRetryCounterCache: store.cacheStore('msg-retry'),
			userDevicesCache: store.cacheStore('user-devices'),
			mediaCache: store.cacheStore('media'),
			callOfferCache: store.cacheStore('call-offers'),
			placeholderResendCache: store.cacheStore('placeholder-resends'),
			getMessage: async key => {
				const id = key.id || JSON.stringify(key)
				return store.get<any>('messages', id).then(message => message?.message)
			},
			cachedGroupMetadata: jid => store.get<any>('groups', jid)
		})

		sock.ev.on('creds.update', auth.saveCreds)
		store.bindToEventEmitter(sock.ev)

		sock.ev.on('connection.update', update => {
			this.broadcast({ type: 'connection.update', sessionId: this.sessionId, update })
			void this.persistConnectionUpdate(update, sock).catch(error => {
				this.broadcast({
					type: 'session.snapshot.error',
					sessionId: this.sessionId,
					error: String(error?.message || error)
				})
			})

			if (update.connection === 'open') {
				this.reconnectAttempts = 0
				void this.state.storage.delete('reconnectAt')
			}

			if (update.connection === 'close') {
				const statusCode = getStatusCode(update.lastDisconnect?.error)
				void this.handleBaileysClose(statusCode)
			}
		})

		sock.ev.on('messages.upsert', event => {
			this.broadcast({ type: 'messages.upsert', sessionId: this.sessionId, event })
			void this.forwardInboundMessages(event).catch(error => {
				this.broadcast({
					type: 'inbound.webhook.error',
					sessionId: this.sessionId,
					error: String(error?.message || error)
				})
			})
		})

		return sock
	}

	private async forwardInboundMessages(event: MessageUpsertEvent) {
		const webhookUrl = this.env.BAILEYS_INBOUND_WEBHOOK_URL
		if (!webhookUrl || event.type !== 'notify') {
			return
		}

		for (const message of event.messages) {
			if (!this.shouldForwardInboundMessage(message)) {
				continue
			}

			await this.forwardInboundMessage(webhookUrl, event, message)
		}
	}

	private shouldForwardInboundMessage(message: WAMessage) {
		const remoteJid = message.key?.remoteJid
		return Boolean(message.key?.id && remoteJid && remoteJid !== 'status@broadcast' && !message.key?.fromMe)
	}

	private async forwardInboundMessage(webhookUrl: string, event: MessageUpsertEvent, message: WAMessage) {
		const remoteJid = message.key?.remoteJid
		const messageId = message.key?.id
		if (!remoteJid || !messageId) {
			return
		}

		const dedupeKey = `inbound-webhook:${remoteJid}:${messageId}`
		if (await this.state.storage.get<number>(dedupeKey)) {
			return
		}

		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-baileys-session-id': this.sessionId,
				...(this.env.BAILEYS_INBOUND_WEBHOOK_SECRET
					? { authorization: `Bearer ${this.env.BAILEYS_INBOUND_WEBHOOK_SECRET}` }
					: {})
			},
			body: JSON.stringify(
				{
					type: 'whatsapp.message.received',
					source: 'baileys-cloudflare-worker',
					sessionId: this.sessionId,
					eventType: event.type,
					messageId,
					conversationId: remoteJid,
					from: message.key?.participant || remoteJid,
					pushName: message.pushName,
					message
				},
				BufferJSON.replacer
			)
		})

		if (!response.ok) {
			throw new Error(`Inbound webhook failed with status ${response.status}`)
		}

		await this.state.storage.put(dedupeKey, Date.now())
	}

	private async handleBaileysClose(statusCode?: number) {
		this.sock = null

		if (statusCode === DisconnectReason.loggedOut) {
			await this.state.storage.put<SessionSnapshot>(SESSION_SNAPSHOT_KEY, {
				connected: false,
				sessionId: this.sessionId,
				status: 'logged-out',
				success: true,
				updatedAt: new Date().toISOString()
			})
			this.broadcast({ type: 'baileys.logged-out', sessionId: this.sessionId })
			return
		}

		const immediate = statusCode === DisconnectReason.restartRequired
		await this.scheduleReconnect(immediate ? 250 : this.nextReconnectDelay())
	}

	private nextReconnectDelay() {
		this.reconnectAttempts += 1
		return Math.min(1000 * 2 ** this.reconnectAttempts, 30_000)
	}

	private async scheduleReconnect(delayMs: number) {
		const reconnectAt = Date.now() + delayMs
		await this.state.storage.put('reconnectAt', reconnectAt)
		await this.state.storage.setAlarm(reconnectAt)
		this.broadcast({ type: 'baileys.reconnect.scheduled', sessionId: this.sessionId, reconnectAt })
	}

	private async restartBaileys(reason: string) {
		if (this.restartPromise) return this.restartPromise

		this.restartPromise = (async () => {
			const current = this.sock
			this.sock = null

			if (current) {
				try {
					await current.end(new Error(`Restarting Baileys session: ${reason}`))
				} catch {}
			}

			// Give the close handler a small window to flush creds.update into D1 before reconnecting.
			await sleep(250)
			await this.startBaileys()
			this.broadcast({ type: 'baileys.restarted', sessionId: this.sessionId, reason })
		})().finally(() => {
			this.restartPromise = null
		})

		return this.restartPromise
	}

	private async resetAuth(clearStore: boolean) {
		const current = this.sock
		this.sock = null
		if (current) {
			try {
				await current.end(new Error('Resetting auth state'))
			} catch {}
		}

		await this.env.BAILEYS_D1.prepare('DELETE FROM baileys_auth WHERE session_id = ?1').bind(this.sessionId).run()

		if (clearStore) {
			await this.env.BAILEYS_D1.prepare('DELETE FROM baileys_store WHERE session_id = ?1').bind(this.sessionId).run()
		}

		this.reconnectAttempts = 0
		await this.startBaileys()
	}

	private async sendMessageFromBody(body: Record<string, unknown>) {
		const jid = firstString(body.jid, body.to, body.conversationId, body.chatId)
		if (!jid) {
			throw new Error('jid, to, conversationId, or chatId is required')
		}

		const message = this.resolveOutboundMessage(body)
		const options = await this.resolveOutboundOptions(body)
		const sock = await this.startBaileys()

		return sock.sendMessage(jid, message as any, options as any)
	}

	private resolveOutboundMessage(body: Record<string, unknown>) {
		if (isRecord(body.message)) {
			return body.message
		}

		const text = firstString(body.text, body.message)
		if (!text) {
			throw new Error('text or message is required')
		}

		return { text }
	}

	private async resolveOutboundOptions(body: Record<string, unknown>) {
		const options: Record<string, unknown> = {}

		if (isRecord(body.quoted)) {
			options.quoted = body.quoted
		}

		const replyToMessageId = firstString(body.replyToMessageId)
		if (!options.quoted && replyToMessageId) {
			const store = await createD1BaileysStore(this.env.BAILEYS_D1, { sessionId: this.sessionId })
			const quoted = await store.get<unknown>('messages', replyToMessageId)
			if (quoted) {
				options.quoted = quoted
			}
		}

		return Object.keys(options).length > 0 ? options : undefined
	}

	private async handleCommand(command: ClientCommand) {
		switch (command.type) {
			case 'start':
				await this.startBaileys()
				return { ok: true }
			case 'status':
				return this.getSessionSnapshot()
			case 'restart':
				await this.restartBaileys('client-command')
				return { ok: true }
			case 'logout':
				await this.sock?.logout('client-command')
				return { ok: true }
			case 'reset-auth':
				await this.resetAuth(false)
				return { ok: true }
			case 'reset-all':
				await this.resetAuth(true)
				return { ok: true }
			case 'send-message': {
				const result = await this.sendMessageFromBody({
					jid: command.jid,
					text: command.text,
					message: command.message
				})
				return { ok: true, result }
			}
			default:
				throw new Error(`Unknown command: ${(command as any).type}`)
		}
	}

	private parseCommand(message: string | ArrayBuffer): ClientCommand {
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
		return JSON.parse(text) as ClientCommand
	}

	private broadcast(payload: unknown) {
		for (const ws of this.state.getWebSockets()) {
			this.send(ws, payload)
		}
	}

	private send(ws: WebSocket, payload: unknown) {
		try {
			ws.send(JSON.stringify(payload))
		} catch {}
	}
}
