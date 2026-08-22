import { describe, expect, it, vi } from 'vitest'
import { AppCloseCoordinator } from '../../src/main/app-close-coordinator.js'

describe('AppCloseCoordinator', () => {
  it('deduplicates one pending request and resolves only the owning window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    const coordinator = new AppCloseCoordinator()
    const first = coordinator.request('window', 10)

    expect(coordinator.request('window', 10)).toEqual(first)
    expect(coordinator.resolve(first.id, 11, true)).toBe('stale')
    expect(coordinator.resolve(first.id, 10, true)).toBe('close-window')
    expect(coordinator.resolve(first.id, 10, true)).toBe('stale')
    vi.restoreAllMocks()
  })

  it('lets a quit request supersede a pending window close and supports cancellation', () => {
    const coordinator = new AppCloseCoordinator()
    const windowClose = coordinator.request('window', 10)
    const quit = coordinator.request('quit', 10)

    expect(quit.id).not.toBe(windowClose.id)
    expect(coordinator.resolve(windowClose.id, 10, true)).toBe('stale')
    expect(coordinator.resolve(quit.id, 10, false)).toBe('cancelled')
  })

  it('drops a request when its renderer window is destroyed', () => {
    const coordinator = new AppCloseCoordinator()
    const request = coordinator.request('window', 10)
    coordinator.clearWindow(10)
    expect(coordinator.resolve(request.id, 10, true)).toBe('stale')
  })
})
