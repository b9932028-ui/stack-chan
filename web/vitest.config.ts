import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
          restoreMocks: true,
        },
      },
      {
        // The dev-server middleware is Node code: it needs real file URLs and no DOM.
        resolve: { alias },
        test: {
          name: 'server',
          environment: 'node',
          include: ['server/**/*.test.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
})
