import type { BaileysEventEmitter, CacheStore } from '../Types'
import { BufferJSON } from '../Utils'
import { assertSafeSqlIdentifier, ensureD1BaileysSchema } from './d1-schema'
import type { D1Database, D1PreparedStatement } from './types'

export type D1StoreOptions = {
	/** Isolates store rows for one WhatsApp account/session. */
	sessionId?: string
	/** Defaults to baileys_store. */
	tableName?: string
	/** Creates the default tables automatically. Disable when running migrations manually. */
	autoMigrate?: boolean
}

export type D1StoreListOptions = {
	limit?: number
	afterUpdatedAt?: number
}

export type D1StoreEntry<T = unknown> = {
	id: string
	value: T
	updatedAt: number
}

export type D1BaileysStore = Awaited<ReturnType<typeof createD1BaileysStore>>

const DEFAULT_SESSION_ID = 'default'
const DEFAULT_TABLE = 'baileys_store'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver)

export const createD1BaileysStore = async (db: D1Database, options: D1StoreOptions = {}) => {
	const sessionId = options.sessionId || DEFAULT_SESSION_ID
	const table = assertSafeSqlIdentifier(options.tableName || DEFAULT_TABLE)

	if (options.autoMigrate !== false) {
		await ensureD1BaileysSchema(db)
	}

	const upsertSql = `
		INSERT INTO ${table} (session_id, bucket, id, value, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5)
		ON CONFLICT(session_id, bucket, id)
		DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`
	const selectSql = `SELECT value FROM ${table} WHERE session_id = ?1 AND bucket = ?2 AND id = ?3`
	const deleteSql = `DELETE FROM ${table} WHERE session_id = ?1 AND bucket = ?2 AND id = ?3`

	const upsertStatement = (bucket: string, id: string, value: unknown): D1PreparedStatement => {
		return db.prepare(upsertSql).bind(sessionId, bucket, id, serialize(value), Date.now())
	}

	const removeStatement = (bucket: string, id: string): D1PreparedStatement => {
		return db.prepare(deleteSql).bind(sessionId, bucket, id)
	}

	const get = async <T = unknown>(bucket: string, id: string): Promise<T | undefined> => {
		const row = await db.prepare(selectSql).bind(sessionId, bucket, id).first<{ value: string }>()
		return row?.value ? deserialize<T>(row.value) : undefined
	}

	const upsert = async (bucket: string, id: string, value: unknown) => {
		await upsertStatement(bucket, id, value).run()
	}

	const upsertMany = async (bucket: string, entries: Array<{ id: string; value: unknown }>) => {
		if (entries.length === 0) return
		await db.batch(entries.map(entry => upsertStatement(bucket, entry.id, entry.value)))
	}

	const remove = async (bucket: string, id: string) => {
		await removeStatement(bucket, id).run()
	}

	const removeMany = async (bucket: string, ids: string[]) => {
		if (ids.length === 0) return
		await db.batch(ids.map(id => removeStatement(bucket, id)))
	}

	const list = async <T = unknown>(
		bucket: string,
		listOptions: D1StoreListOptions = {}
	): Promise<D1StoreEntry<T>[]> => {
		const limit = Math.min(Math.max(listOptions.limit || 100, 1), 1000)
		const afterUpdatedAt = listOptions.afterUpdatedAt || 0

		const result = await db
			.prepare(
				`SELECT id, value, updated_at as updatedAt
				 FROM ${table}
				 WHERE session_id = ?1 AND bucket = ?2 AND updated_at > ?3
				 ORDER BY updated_at ASC
				 LIMIT ?4`
			)
			.bind(sessionId, bucket, afterUpdatedAt, limit)
			.all<{ id: string; value: string; updatedAt: number }>()

		return (result.results || []).map(row => ({
			id: row.id,
			value: deserialize<T>(row.value),
			updatedAt: row.updatedAt
		}))
	}

	const clear = async (bucket?: string) => {
		if (bucket) {
			await db.prepare(`DELETE FROM ${table} WHERE session_id = ?1 AND bucket = ?2`).bind(sessionId, bucket).run()
			return
		}

		await db.prepare(`DELETE FROM ${table} WHERE session_id = ?1`).bind(sessionId).run()
	}

	const cacheStore = (bucket: string): CacheStore => ({
		get: <T>(key: string) => get<T>(bucket, key) as Promise<T>,
		set: <T>(key: string, value: T) => upsert(bucket, key, value),
		del: (key: string) => remove(bucket, key),
		flushAll: () => clear(bucket),
		close: () => undefined
	})
	const toStoreEntry = <T>(id: string | null | undefined, value: T): Array<{ id: string; value: T }> => {
		return id ? [{ id, value }] : []
	}

	const bindToEventEmitter = (ev: BaileysEventEmitter) => {
		ev.on('messages.upsert', async ({ messages }) => {
			await upsertMany(
				'messages',
				messages.flatMap(message => toStoreEntry(message.key.id || JSON.stringify(message.key), message))
			)
		})

		ev.on('contacts.upsert', async contacts => {
			await upsertMany(
				'contacts',
				contacts.flatMap(contact =>
					toStoreEntry(
						contact.id || ('jid' in contact && typeof contact.jid === 'string' ? contact.jid : undefined),
						contact
					)
				)
			)
		})

		ev.on('contacts.update', async contacts => {
			await upsertMany(
				'contacts',
				contacts.flatMap(contact =>
					toStoreEntry(
						contact.id || ('jid' in contact && typeof contact.jid === 'string' ? contact.jid : undefined),
						contact
					)
				)
			)
		})

		ev.on('chats.upsert', async chats => {
			await upsertMany(
				'chats',
				chats.flatMap(chat => toStoreEntry(chat.id, chat))
			)
		})

		ev.on('chats.update', async chats => {
			await upsertMany(
				'chats',
				chats.flatMap(chat => toStoreEntry(chat.id, chat))
			)
		})

		ev.on('groups.update', async groups => {
			await upsertMany(
				'groups',
				groups.flatMap(group => toStoreEntry(group.id, group))
			)
		})
	}

	return {
		get,
		upsert,
		upsertMany,
		remove,
		removeMany,
		list,
		clear,
		cacheStore,
		bindToEventEmitter
	}
}
