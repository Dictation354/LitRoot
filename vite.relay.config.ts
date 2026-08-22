import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
])

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: 'dist/relay',
    sourcemap: false,
    ssr: 'src/mcp/main.ts',
    target: 'node24',
    rollupOptions: {
      external: (source) => nodeBuiltins.has(source),
      output: {
        codeSplitting: false,
        entryFileNames: 'paperrelay-relay.cjs',
        format: 'cjs'
      }
    }
  },
  ssr: {
    noExternal: true
  }
})
