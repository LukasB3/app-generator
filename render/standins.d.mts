// Types of standins.mjs, for the tests that run it outside the container.
export interface StandInConfig {
  base: string
  files: Map<string, Buffer>
  database: { url: string; prefix: string; tables: string[] } | null
  liveData: string | null
  now: number
}
export interface StandInRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
}
export interface StandInAnswer {
  status: number
  headers: Record<string, string>
  body: string | Buffer
  missing?: string
}
export interface StandInState {
  tables: Map<string, { rows: Record<string, unknown>[]; nextId: number }>
  clock: number
}
export const newState: () => StandInState
export const respond: (config: StandInConfig, state: StandInState, request: StandInRequest) => StandInAnswer | null
