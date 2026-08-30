import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({

  plugins: [react()],
  // If deploying to GitHub Pages subdirectory e.g. /InsiderTrader/
  // set base to match. For root domain or Cloudflare Pages, use '/'
  base: '/',
})
