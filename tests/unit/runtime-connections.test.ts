import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/litroot-test' },
  dialog: {}
}))

import { parseConnections } from '../../src/main/app-controller.js'

describe('runtime connection persistence', () => {
  it('migrates schema v1 WSL distributions while reading', () => {
    expect(parseConnections({
      schemaVersion: 1,
      projects: [{
        projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
        distribution: 'Ubuntu',
        path: '/home/me/research',
        name: 'Research'
      }]
    })).toEqual([{
      projectId: 'project_aaaaaaaaaaaaaaaaaaaaaaaa',
      runtime: { kind: 'wsl', distribution: 'Ubuntu' },
      path: '/home/me/research',
      name: 'Research'
    }])
  })

  it('reads schema v2 local runtime records', () => {
    expect(parseConnections({
      schemaVersion: 2,
      projects: [{
        projectId: 'project_bbbbbbbbbbbbbbbbbbbbbbbb',
        runtime: { kind: 'local' },
        path: '/data/research',
        name: 'Local'
      }]
    })[0]?.runtime).toEqual({ kind: 'local' })
  })
})
