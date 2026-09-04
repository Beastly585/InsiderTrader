// src/main.jsx — Vite entry point with Clerk auth
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { PostHogProvider } from '@posthog/react'
import './style.css'
import App from './app.jsx'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!PUBLISHABLE_KEY) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env.local')
}

const posthogOptions = {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: '2026-05-30',
  // Suppress console errors when ad blockers prevent PostHog from loading.
  // The SDK retries and spams ERR_BLOCKED_BY_CLIENT — this doesn't affect
  // the app, but it clutters the console and looks alarming in dev tools.
  disable_external_dependency_loading: false,
  on_xhr_error: () => {},
  // Reduce retry noise — if the first request is blocked, retries will be too.
  request_batching: { max_batch_size: 1 },
}


ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PostHogProvider
      apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY}
      options={posthogOptions}
    >
      <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
        <App />
      </ClerkProvider>
    </PostHogProvider>
  </React.StrictMode>
)
