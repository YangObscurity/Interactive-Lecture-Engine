export interface DbQueryResult<T = Record<string, unknown>> {
  rows: T[]
  rowCount: number
}

export interface DbClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbQueryResult<T>>
  exec(sql: string): Promise<void>
}

export interface Db extends DbClient {
  readonly kind: 'pg' | 'pglite'
  tx<R>(fn: (client: DbClient) => Promise<R>): Promise<R>
  close(): Promise<void>
  withSession?<R>(fn: (sessionDb: Db) => Promise<R>): Promise<R>
}
