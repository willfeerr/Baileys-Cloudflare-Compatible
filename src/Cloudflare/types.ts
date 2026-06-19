export type D1Primitive = string | number | boolean | null | ArrayBuffer | Uint8Array

export type D1Bindable = D1Primitive | Date

export type D1Result<T = unknown> = {
	results?: T[]
	success: boolean
	meta: Record<string, unknown>
	error?: string
}

export type D1PreparedStatement = {
	bind(...values: D1Bindable[]): D1PreparedStatement
	first<T = Record<string, unknown>>(colName?: string): Promise<T | null>
	all<T = Record<string, unknown>>(): Promise<D1Result<T>>
	run<T = unknown>(): Promise<D1Result<T>>
}

export type D1Database = {
	prepare(query: string): D1PreparedStatement
	batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
	exec(query: string): Promise<unknown>
}
