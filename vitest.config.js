import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    environment: 'node', // pure logic tests — no DOM needed
    include: ['src/**/*.test.js', 'worker/**/*.test.js'],
  },
});
