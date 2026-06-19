import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { BufferJSON, initAuthCreds } from '../Utils'
import { assertSafeSqlIdentifier, ensureD1BaileysSchema } from './d1-schema'
import type { D1Database, D1PreparedStatement } from './types'

export type D1AuthStateOptions = {
	/** Isolates credentials and signal keys for one WhatsApp account/session. */
	sessionId?: string
	/** Defaults to baileys_auth. */
	tableName?: string
	/** Creates the default tables automatically. Disable when running migrations manually. */
	autoMigrate?: boolean
}

const DEFAULT_SESSION_ID = 'default'
const DEFAULT_TABLE = 'baileys_auth'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver)

export const useD1AuthState = async (
	db: D1Database,
	options: D1AuthStateOptions = {}
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	const sessionId = options.sessionId || DEFAULT_SESSION_ID
	const table = assertSafeSqlIdentifier(options.tableName || DEFAULT_TABLE)

	if (options.autoMigrate !== false) {
		await ensureD1BaileysSchema(db)
	}

	const upsertSql = `
		INSERT INTO ${table} (session_id, key, value, updated_at)
		VALUES (?1, ?2, ?3, ?4)
		ON CONFLICT(session_id, key)
		DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`
	const deleteSql = `DELETE FROM ${table} WHERE session_id = ?1 AND key = ?2`
	const selectSql = `SELECT value FROM ${table} WHERE session_id = ?1 AND key = ?2`

	const readData = async <T>(key: string): Promise<T | null> => {
		const row = await db.prepare(selectSql).bind(sessionId, key).first<{ value: string }>()
		return row?.value ? deserialize<T>(row.value) : null
	}

	const writeStatement = (key: string, value: unknown): D1PreparedStatement => {
		return db.prepare(upsertSql).bind(sessionId, key, serialize(value), Date.now())
	}

	const deleteStatement = (key: string): D1PreparedStatement => {
		return db.prepare(deleteSql).bind(sessionId, key)
	}

	const writeData = async (key: string, value: unknown) => {
		await writeStatement(key, value).run()
	}

	const creds: AuthenticationCreds = (await readData<AuthenticationCreds>('creds')) || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}

					await Promise.all(
						ids.map(async id => {
							let value = await readData<SignalDataTypeMap[typeof type]>(`key:${type}:${id}`)

							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value) as SignalDataTypeMap[typeof type]
							}

							data[id] = value as SignalDataTypeMap[typeof type]
						})
					)

					return data
				},
				set: async data => {
					const statements: D1PreparedStatement[] = []

					for (const category in data) {
						const typedCategory = category as keyof SignalDataTypeMap
						const categoryData = data[typedCategory]

						for (const id in categoryData) {
							const value = categoryData[id]
							const key = `key:${category}:${id}`
							statements.push(value ? writeStatement(key, value) : deleteStatement(key))
						}
					}

					if (statements.length > 0) {
						await db.batch(statements)
					}
				}
			}
		},
		saveCreds: async () => writeData('creds', creds)
	}
}
