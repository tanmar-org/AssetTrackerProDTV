export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ results: Record<string, unknown>[]; meta: { changes: number } }>;
}
export interface Database {
  prepare(text: string): Statement;
  transaction<T>(callback: (transaction: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function createDatabase(connectionString: string | undefined): Database;
