import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: 'index.html', apps: 'apps.html', safety: 'safety.html', legal: 'legal.html', why: 'why.html' },
    },
  },
})
