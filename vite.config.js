import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  root: 'src',
  publicDir: 'public',
  plugins: [
    viteSingleFile({
      removeViteModuleLoader: false,
      useRecommendedBuildConfig: false,
      inlinePattern: ['!**/*.wasm', '!**/cimbar/**']
    })
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'terser',
    copyPublicDir: true
  },
  worker: {
    format: 'es'
  }
})
