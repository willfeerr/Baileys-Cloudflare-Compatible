import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
const WS_CLOSED = 3

type WebSocketCloseListener = (...args: any[]) => void

type NodeWebSocketLike = {
	readyState: number
	send(data: string | Uint8Array, cb?: (err?: Error) => void): void
	close(code?: number, reason?: string): void
	on(event: string, listener: (...args: any[]) => void): void
	once(event: string, listener: WebSocketCloseListener): void
	setMaxListeners?(n: number): void
}

type RuntimeWebSocketLike = {
	readyState: number
	binaryType?: BinaryType
	accept?: (options?: { allowHalfOpen?: boolean }) => void
	send(data: string | ArrayBuffer | ArrayBufferView): void
	close(code?: number, reason?: string): void
	addEventListener(event: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void, options?: any): void
}

type SocketLike = NodeWebSocketLike | RuntimeWebSocketLike

type WebSocketUpgradeResponse = Response & {
	webSocket?: RuntimeWebSocketLike
}

const isCloudflareRuntime = () => typeof (globalThis as any).WebSocketPair !== 'undefined'

const toFetchUpgradeUrl = (url: URL) => {
	const fetchUrl = new URL(url)
	if (fetchUrl.protocol === 'wss:') {
		fetchUrl.protocol = 'https:'
	} else if (fetchUrl.protocol === 'ws:') {
		fetchUrl.protocol = 'http:'
	}

	return fetchUrl
}

const toBuffer = async (data: unknown): Promise<string | Buffer> => {
	if (typeof data === 'string') {
		return data
	}

	if (data instanceof ArrayBuffer) {
		return Buffer.from(data)
	}

	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	}

	if (typeof Blob !== 'undefined' && data instanceof Blob) {
		return Buffer.from(await data.arrayBuffer())
	}

	return Buffer.from(data as ArrayBuffer)
}

export class WebSocketClient extends AbstractSocketClient {
	protected socket: SocketLike | null = null
	private abortController: AbortController | null = null
	private connectPromise: Promise<void> | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WS_OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WS_CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WS_CLOSING
	}
	get isConnecting(): boolean {
		return Boolean(this.connectPromise) || this.socket?.readyState === WS_CONNECTING
	}

	connect() {
		if (this.socket || this.connectPromise) {
			return
		}

		this.connectPromise = (isCloudflareRuntime() ? this.connectWithCloudflareFetchUpgrade() : this.connectWithNodeWs())
			.catch(error => {
				this.emit('error', error)
				void this.close()
			})
			.finally(() => {
				this.connectPromise = null
			})
	}

	private async connectWithNodeWs() {
		const { default: WebSocket } = await import('ws')

		const socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket = socket
		socket.setMaxListeners(0)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			socket.on(event, (...args: any[]) => this.emit(event, ...args))
		}
	}

	private async connectWithCloudflareFetchUpgrade() {
		this.abortController = new AbortController()

		const headers = new Headers(this.config.options?.headers as HeadersInit | undefined)
		headers.set('Origin', DEFAULT_ORIGIN)
		headers.set('Upgrade', 'websocket')

		const response = (await fetch(toFetchUpgradeUrl(this.url).toString(), {
			...this.config.options,
			headers,
			signal: this.abortController.signal
		})) as WebSocketUpgradeResponse

		if (response.status !== 101 || !response.webSocket) {
			throw new Error(`WebSocket upgrade failed: ${response.status}`)
		}

		const socket = response.webSocket
		socket.binaryType = 'arraybuffer'
		this.socket = socket

		socket.addEventListener('message', event => {
			void toBuffer(event.data)
				.then(data => this.emit('message', data))
				.catch(error => this.emit('error', error))
		})
		socket.addEventListener('error', event => this.emit('error', event))
		socket.addEventListener('close', event => {
			this.socket = null
			this.abortController = null
			this.emit('close', event.code, event.reason)
		})

		socket.accept?.({ allowHalfOpen: true })
		this.emit('open')
	}

	async close() {
		const socket = this.socket
		this.abortController?.abort()

		if (!socket) {
			this.abortController = null
			return
		}

		const closePromise = new Promise<void>(resolve => {
			if ('once' in socket) {
				socket.once('close', () => resolve())
			} else {
				socket.addEventListener('close', () => resolve(), { once: true })
			}
		})

		socket.close()
		await closePromise.catch(() => undefined)

		this.socket = null
		this.abortController = null
	}

	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		try {
			if (!this.socket || this.socket.readyState !== WS_OPEN) {
				throw new Error('WebSocket is not open')
			}

			if ('once' in this.socket) {
				this.socket.send(str, cb)
			} else {
				this.socket.send(str)
				cb?.()
			}

			return true
		} catch (error) {
			cb?.(error as Error)
			return false
		}
	}
}
