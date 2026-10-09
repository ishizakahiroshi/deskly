/** The Workers binding and local Miniflare binding satisfy this narrow structural port. */
export type D1Value = string | number | null;
export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta?: { changes?: number };
}
export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Driver {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
export async function batch<T = Record<string, unknown>>(driver: D1Driver, queries: D1Statement[]): Promise<D1Result<T>[]> {
  const result = await driver.batch<T>(queries);
  if (result.length !== queries.length || result.some(value => !value.success)) throw new Error('D1 batch failed');
  return result;
}
