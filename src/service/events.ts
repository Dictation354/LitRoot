import { EventEmitter } from 'node:events'
import type { ServiceEvent } from '../shared/contracts.js'

export class ServiceEventBus {
  private readonly emitter = new EventEmitter()

  emit(event: ServiceEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
