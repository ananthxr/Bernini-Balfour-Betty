import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // static build works from any path / file host
  build: { chunkSizeWarningLimit: 1600 },
})
