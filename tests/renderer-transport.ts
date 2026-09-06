import type {
  BridgeErrorPayload,
  BridgeResult,
  LitRootBridge,
  LitRootTransportBridge
} from '../src/shared/contracts.js'

function payload(error: unknown): BridgeErrorPayload {
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code')
    const details = Reflect.get(error, 'details')
    return {
      code: typeof code === 'string' ? code : 'internal_error',
      message: error.message,
      ...(details === undefined ? {} : { details })
    }
  }
  return { code: 'internal_error', message: '操作失败。' }
}

function transportSection(section: object | undefined, synchronous: string[] = []): object {
  return new Proxy(section ?? {}, {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function' || synchronous.includes(String(property))) return member
      return async (...args: unknown[]): Promise<BridgeResult<unknown>> => {
        try {
          const value = await member(...args)
          return { ok: true, value: value === undefined ? null : value }
        } catch (error) {
          return { ok: false, error: payload(error) }
        }
      }
    }
  })
}

export function transportFor(facade: LitRootBridge): LitRootTransportBridge {
  return {
    system: transportSection(facade.system),
    projects: transportSection(facade.projects),
    papers: transportSection(facade.papers, ['assetUrl']),
    notes: transportSection(facade.notes),
    fetch: transportSection(facade.fetch),
    feeds: transportSection(facade.feeds),
    events: facade.events ?? { subscribe: () => () => undefined }
  } as LitRootTransportBridge
}
