/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  readonly VITE_TURNSTILE_SITEKEY?: string
  readonly VITE_TURNSTILE_LOGIN_SITEKEY?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_KEY?: string
}

interface Turnstile {
  render(
    container: string,
    options: {
      sitekey: string
      appearance?: 'always' | 'execute' | 'interaction-only'
      callback: (token: string) => void
      'expired-callback'?: () => void
      'before-interactive-callback'?: () => void
      'after-interactive-callback'?: () => void
    },
  ): string
  reset(widget?: string): void
  remove(widget: string): void
}

interface Window {
  turnstile?: Turnstile
  onTurnstileLoad?: () => void
}
