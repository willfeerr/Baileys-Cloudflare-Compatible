import type { D1Database } from './types'

export const D1_BAILEYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS baileys_auth (
	session_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, key)
);

CREATE INDEX IF NOT EXISTS idx_baileys_auth_session_updated
	ON baileys_auth (session_id, updated_at);

CREATE TABLE IF NOT EXISTS baileys_store (
	session_id TEXT NOT NULL,
	bucket TEXT NOT NULL,
	id TEXT NOT NULL,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, bucket, id)
);

CREATE INDEX IF NOT EXISTS idx_baileys_store_session_bucket_updated
	ON baileys_store (session_id, bucket, updated_at);
`

export const ensureD1BaileysSchema = async (db: D1Database) => {
	await db.exec(D1_BAILEYS_SCHEMA)
}

export const assertSafeSqlIdentifier = (name: string) => {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		throw new Error(`Unsafe SQL identifier: ${name}`)
	}

	return name
}
