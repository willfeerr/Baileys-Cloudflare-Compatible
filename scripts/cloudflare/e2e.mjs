#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket from 'ws'

const isWindows = process.platform === 'win32'
const npx = isWindows ? 'npx.cmd' : 'npx'

const args = new Set(process.argv.slice(2))
const argValue = name => {
	const index = process.argv.indexOf(name)
	return index >= 0 ? process.argv[index + 1] : undefined
}

const target = argValue('--target') || process.env.BAILEYS_E2E_TARGET || 'local'
const live = args.has('--live') || process.env.BAILEYS_E2E_LIVE === '1'
const deploy = args.has('--deploy') || process.env.BAILEYS_E2E_DEPLOY === '1'
const config = argValue('--config') || process.env.BAILEYS_E2E_CONFIG || 'cloudflare/wrangler.test.jsonc'
const database = process.env.BAILEYS_E2E_D1_DATABASE || 'baileys_cloudflare_e2e'
const port = Number(argValue('--port') || process.env.BAILEYS_E2E_PORT || 8797)
const sessionId = argValue('--session') || process.env.BAILEYS_E2E_SESSION || `e2e-${Date.now()}`
const token = process.env.BAILEYS_E2E_TOKEN || 'test-token'
const localBaseUrl = `http://127.0.0.1:${port}`
const remoteBaseUrl = argValue('--base-url') || process.env.BAILEYS_E2E_BASE_URL
const baseUrl = target === 'remote' ? remoteBaseUrl : localBaseUrl
const pairingTimeoutMs = Number(process.env.BAILEYS_E2E_PAIRING_TIMEOUT_MS || 180_000)
const startupTimeoutMs = Number(process.env.BAILEYS_E2E_STARTUP_TIMEOUT_MS || 90_000)
const sendJid = process.env.BAILEYS_E2E_SEND_JID
const sendText = process.env.BAILEYS_E2E_SEND_TEXT || 'Teste via Cloudflare Durable Object e2e'

if (target === 'remote' && !baseUrl) {
	throw new Error('Remote target requires --base-url or BAILEYS_E2E_BASE_URL')
}

const step = async (name, fn) => {
	process.stdout.write(`\n▶ ${name}\n`)
	await fn()
	process.stdout.write(`✓ ${name}\n`)
}

const run = (command, commandArgs, options = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: process.cwd(),
			env: { ...process.env, ...(options.env || {}) },
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let output = ''
		child.stdout.on('data', chunk => {
			const text = chunk.toString()
			output += text
			if (options.print) process.stdout.write(text)
		})
		child.stderr.on('data', chunk => {
			const text = chunk.toString()
			output += text
			if (options.print) process.stderr.write(text)
		})
		child.on('error', reject)
		child.on('close', code => {
			if (code === 0 || options.allowFailure) {
				resolve({ code, output })
			} else {
				reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}\n${output}`))
			}
		})
	})

const spawnWranglerDev = () => {
	const child = spawn(npx, ['wrangler', 'dev', '--config', config, '--port', String(port)], {
		cwd: process.cwd(),
		env: { ...process.env },
		shell: false,
		stdio: ['ignore', 'pipe', 'pipe']
	})

	child.stdout.on('data', chunk => process.stdout.write(chunk.toString()))
	child.stderr.on('data', chunk => process.stderr.write(chunk.toString()))
	child.on('exit', code => {
		if (code && code !== 0) {
			process.stderr.write(`\nwrangler dev exited with code ${code}\n`)
		}
	})

	return child
}

const stopChild = async child => {
	if (!child || child.killed) return
	child.kill('SIGTERM')
	await sleep(800)
	if (!child.killed) child.kill('SIGKILL')
}

const fetchJson = async (url, options = {}) => {
	const response = await fetch(url, {
		...options,
		headers: {
			...(options.headers || {}),
			...(options.auth === false ? {} : { Authorization: `Bearer ${token}` })
		}
	})

	const text = await response.text()
	let body
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = text
	}

	return { response, body, text }
}

const waitForHttp = async url => {
	const started = Date.now()
	let lastError

	while (Date.now() - started < startupTimeoutMs) {
		try {
			const { response } = await fetchJson(url)
			if (response.status < 500) return
		} catch (error) {
			lastError = error
		}
		await sleep(500)
	}

	throw new Error(`Timed out waiting for ${url}. Last error: ${lastError?.message || 'none'}`)
}

const openWs = async url => {
	const ws = new WebSocket(url, {
		headers: { Authorization: `Bearer ${token}` }
	})

	const messages = []
	const waiters = []

	ws.on('message', data => {
		const raw = data.toString()
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			parsed = raw
		}

		messages.push(parsed)
		for (const waiter of [...waiters]) {
			if (waiter.predicate(parsed)) {
				waiters.splice(waiters.indexOf(waiter), 1)
				waiter.resolve(parsed)
			}
		}
	})

	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Timed out opening WebSocket ${url}`)), 15_000)
		ws.once('open', () => {
			clearTimeout(timeout)
			resolve()
		})
		ws.once('error', error => {
			clearTimeout(timeout)
			reject(error)
		})
	})

	const waitFor = (predicate, timeoutMs, label) => {
		for (const message of messages) {
			if (predicate(message)) return Promise.resolve(message)
		}

		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve, reject }
			const timeout = setTimeout(() => {
				waiters.splice(waiters.indexOf(waiter), 1)
				reject(new Error(`Timed out waiting for WebSocket message: ${label}`))
			}, timeoutMs)

			waiter.resolve = value => {
				clearTimeout(timeout)
				resolve(value)
			}
			waiters.push(waiter)
		})
	}

	const sendJson = payload => ws.send(JSON.stringify(payload))
	const close = () => ws.readyState === WebSocket.OPEN && ws.close()

	return { ws, messages, waitFor, sendJson, close }
}

const commandResult = requestId => message => message?.type === 'command.result' && message.requestId === requestId
const commandError = requestId => message => message?.type === 'command.error' && (!requestId || message.requestId === requestId)

const maybeRenderQr = async qr => {
	process.stdout.write('\nQR recebido. Escaneie no WhatsApp se o terminal renderizar corretamente.\n')
	process.stdout.write(`\nQR RAW:\n${qr}\n\n`)
	await run(npx, ['qrcode-terminal', qr], { allowFailure: true, print: true })
}

const preflight = async () => {
	const required = [
		'cloudflare/baileys-session-do.ts',
		'cloudflare/schema.sql',
		config,
		'src/Cloudflare/d1-auth-state.ts',
		'src/Cloudflare/d1-store.ts',
		'src/Socket/Client/websocket.ts'
	]

	for (const file of required) {
		assert.equal(existsSync(file), true, `Missing required file: ${file}`)
	}
}

const applyD1Schema = async mode => {
	await run(npx, ['wrangler', 'd1', 'execute', database, '--config', config, mode, '--file', 'cloudflare/schema.sql'], {
		print: true
	})
}

const assertD1HasTables = async mode => {
	const { output } = await run(
		npx,
		[
			'wrangler',
			'd1',
			'execute',
			database,
			'--config',
			config,
			mode,
			'--command',
			"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('baileys_auth', 'baileys_store') ORDER BY name;"
		],
		{ print: true }
	)

	assert.match(output, /baileys_auth/, 'D1 table baileys_auth was not found')
	assert.match(output, /baileys_store/, 'D1 table baileys_store was not found')
}

const assertD1HasCreds = async mode => {
	const { output } = await run(
		npx,
		[
			'wrangler',
			'd1',
			'execute',
			database,
			'--config',
			config,
			mode,
			'--command',
			`SELECT key FROM baileys_auth WHERE session_id='${sessionId}' ORDER BY updated_at DESC LIMIT 20;`
		],
		{ print: true }
	)

	assert.match(output, /creds/, 'D1 did not persist creds for this session')
}

const smokeHttp = async () => {
	const unauthorized = await fetchJson(`${baseUrl}/session/${sessionId}`, { auth: false })
	assert.equal(unauthorized.response.status, 401, 'Expected 401 without Authorization header')

	const health = await fetchJson(`${baseUrl}/session/${sessionId}`)
	assert.equal(health.response.status, 200)
	assert.equal(health.body.ok, true)
	assert.equal(health.body.sessionId, sessionId)

	const notFound = await fetchJson(`${baseUrl}/nope/${sessionId}`)
	assert.equal(notFound.response.status, 404)
}

const smokeWebSocket = async () => {
	const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/session/${sessionId}`
	const client = await openWs(wsUrl)

	try {
		const hello = await client.waitFor(message => message?.type === 'hello', 10_000, 'hello')
		assert.equal(hello.sessionId, sessionId)

		client.sendJson({ type: 'status', requestId: 'status-smoke' })
		const status = await client.waitFor(commandResult('status-smoke'), 10_000, 'status result')
		assert.equal(status.result.ok, true)
		assert.equal(status.result.sessionId, sessionId)
		assert.equal(status.result.connected, false)

		client.sendJson({ type: 'unknown-command', requestId: 'bad-command' })
		const error = await client.waitFor(commandError('bad-command'), 10_000, 'unknown command error')
		assert.match(error.error, /Unknown command/)
	} finally {
		client.close()
	}
}

const liveWhatsAppFlow = async mode => {
	const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/session/${sessionId}`
	const client = await openWs(wsUrl)

	try {
		await client.waitFor(message => message?.type === 'hello', 10_000, 'hello')

		client.sendJson({ type: 'start', requestId: 'live-start' })
		await client.waitFor(commandResult('live-start'), 30_000, 'start result')

		let qrRendered = false
		const openMessage = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Timed out waiting for QR or connection open')), pairingTimeoutMs)

			const check = async message => {
				if (message?.type === 'baileys.start.error') {
					clearTimeout(timeout)
					reject(new Error(`Baileys start error: ${message.error}`))
					return true
				}

				if (message?.type === 'connection.update') {
					if (message.update?.qr && !qrRendered) {
						qrRendered = true
						await maybeRenderQr(message.update.qr)
					}

					if (message.update?.connection === 'open') {
						clearTimeout(timeout)
						resolve(message)
						return true
					}
				}

				return false
			}

			for (const message of client.messages) {
				void check(message)
			}

			const originalLength = client.messages.length
			const interval = setInterval(() => {
				for (const message of client.messages.slice(originalLength)) {
					void check(message)
				}
			}, 250)

			setTimeout(() => clearInterval(interval), pairingTimeoutMs + 500)
		})

		assert.equal(openMessage.update.connection, 'open')
		await assertD1HasCreds(mode)

		client.sendJson({ type: 'restart', requestId: 'live-restart' })
		await client.waitFor(commandResult('live-restart'), 30_000, 'restart result')
		await client.waitFor(message => message?.type === 'baileys.restarted', 45_000, 'baileys restarted')

		if (sendJid) {
			client.sendJson({ type: 'send-message', requestId: 'live-send', jid: sendJid, text: sendText })
			const sent = await client.waitFor(commandResult('live-send'), 45_000, 'send-message result')
			assert.equal(sent.result.ok, true)
		} else {
			process.stdout.write('\nBAILEYS_E2E_SEND_JID não definido; pulando teste de envio de mensagem.\n')
		}
	} finally {
		client.close()
	}
}

let devProcess

try {
	await step('preflight files', preflight)

	if (target === 'local') {
		await step('apply D1 local schema', () => applyD1Schema('--local'))
		await step('assert D1 local tables', () => assertD1HasTables('--local'))
		await step('start wrangler dev', async () => {
			devProcess = spawnWranglerDev()
			await waitForHttp(`${baseUrl}/session/${sessionId}`)
		})
	} else {
		if (deploy) {
			await step('apply D1 remote schema', () => applyD1Schema('--remote'))
			await step('deploy Worker', () => run(npx, ['wrangler', 'deploy', '--config', config], { print: true }))
		}
		await step('wait for remote Worker', () => waitForHttp(`${baseUrl}/session/${sessionId}`))
	}

	await step('HTTP smoke', smokeHttp)
	await step('WebSocket smoke', smokeWebSocket)

	if (live) {
		await step('live WhatsApp pairing/restart flow', () => liveWhatsAppFlow(target === 'local' ? '--local' : '--remote'))
	} else {
		process.stdout.write('\nSmoke OK. Para testar QR/pairing real, rode com --live ou use yarn test:cloudflare:live.\n')
	}

	process.stdout.write('\n✅ Cloudflare e2e concluído com sucesso.\n')
} finally {
	await stopChild(devProcess)
}
