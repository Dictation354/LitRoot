import type { AgentRelayErrorCode, AgentRelayErrorPayload } from './contracts.js'

export class AgentRelayError extends Error {
  readonly code: AgentRelayErrorCode
  readonly details: Record<string, unknown> | null

  constructor(code: AgentRelayErrorCode, message: string, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'AgentRelayError'
    this.code = code
    this.details = details
  }

  toPayload(): AgentRelayErrorPayload {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function relayErrorPayload(error: unknown): AgentRelayErrorPayload {
  if (error instanceof AgentRelayError) return error.toPayload()
  return {
    code: 'INTERNAL_ERROR',
    message: 'PaperRelay encountered an unexpected internal error while serving this read-only request.',
    details: null
  }
}
