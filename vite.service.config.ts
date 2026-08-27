import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
])

export default defineConfig({
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: 'dist/service',
    sourcemap: false,
    ssr: 'src/service/main.ts',
    target: 'node24',
    rollupOptions: {
      external: (source) => nodeBuiltins.has(source),
      output: {
        codeSplitting: false,
        entryFileNames: 'litroot-service.cjs',
        format: 'cjs'
      }
    }
  },
  ssr: { noExternal: true }
})
