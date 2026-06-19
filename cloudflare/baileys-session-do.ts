import makeWASocket, {
	DisconnectReason,
	createD1BaileysStore,
	type D1Database,
	useD1AuthState
} from '../src/index'
import { miniWhatsAppResponse } from './mini-whatsapp-app'

export interface Env {
	BAILEYS_SESSION: DurableObjectNamespace
	BAILEYS_D1: D1Database
	BAILEYS_API_TOKEN?: string
	/** Set to false/0/no/off to keep WebSocket smoke tests from connecting to WhatsApp automatically. */
	BAILEYS_AUTO_START?: string
}

type WASocket = ReturnType<typeof makeWASocket>

type ClientCommand = {
	type: 'start' | 'status' | 'restart' | 'logout' | 'reset-auth' | 'reset-all' | 'send-message'
	requestId?: string
	jid?: string
	text?: string
	message?: Record<string, unknown>
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	})

const getStatusCode = (error: unknown): number | undefined => {
	return (error as any)?.output?.statusCode || (error as any)?.statusCode
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const isDisabled = (value: string | undefined) => ['false', '0', 'no', 'off'].includes(String(value || '').toLowerCase())

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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const [, route, sessionId = 'default'] = url.pathname.split('/')

		if (route === '' || route === 'app') {
			return miniWhatsAppResponse()
		}

		if (route !== 'session') {
			return json({ ok: false, error: 'Use /app or /session/:sessionId' }, 404)
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

		if (url.pathname.endsWith('/start')) {
			await this.startBaileys()
			return json({ ok: true, sessionId: this.sessionId })
		}

		if (url.pathname.endsWith('/restart')) {
			await this.restartBaileys('http-command')
			return json({ ok: true, sessionId: this.sessionId })
		}

		if (url.pathname.endsWith('/reset-auth')) {
			await this.resetAuth(false)
			return json({ ok: true, sessionId: this.sessionId })
		}

		return json({ ok: true, sessionId: this.sessionId, connected: Boolean(this.sock?.ws?.isOpen) })
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
		ws.close(code, reason)
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
		})

		return sock
	}

	private async handleBaileysClose(statusCode?: number) {
		this.sock = null

		if (statusCode === DisconnectReason.loggedOut) {
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

	private async handleCommand(command: ClientCommand) {
		switch (command.type) {
			case 'start':
				await this.startBaileys()
				return { ok: true }
			case 'status':
				return { ok: true, connected: Boolean(this.sock?.ws?.isOpen), sessionId: this.sessionId }
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
				if (!command.jid) throw new Error('jid is required')
				const sock = await this.startBaileys()
				const result = await sock.sendMessage(command.jid, command.message || { text: command.text || '' })
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
