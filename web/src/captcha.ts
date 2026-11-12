// Cloudflare Turnstile. Its script is loaded once, however many widgets a page mounts.
let loaded: Promise<Turnstile> | undefined
const turnstile = () =>
  (loaded ??= new Promise((resolve) => {
    window.onTurnstileLoad = () => resolve(window.turnstile!)
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad'
    script.async = true
    document.head.append(script)
  }))

// Puts a widget into `container`. It shows itself only when the visitor has
// to do something. `onToken` gets each solved token, and an empty string when
// one expires. While it asks the visitor for a click the container has the
// class `asks`.
export const mountCaptcha = (container: string, sitekey: string, onToken: (token: string) => void) => {
  let widget: string | undefined
  let resting = false
  const asks = (now: boolean) => () => document.querySelector(container)?.classList.toggle('asks', now)
  const show = async () => {
    const api = await turnstile()
    if (resting || widget) return
    widget = api.render(container, {
      sitekey,
      appearance: 'interaction-only',
      callback: onToken,
      'expired-callback': () => onToken(''),
      'before-interactive-callback': asks(true),
      'after-interactive-callback': asks(false),
    })
  }
  void show()
  return {
    // Asks for a fresh token, since each one works only once.
    renew: () => {
      onToken('')
      window.turnstile?.reset(widget)
    },
    // Takes the widget away. Until `wake` no check runs and nothing asks the visitor for a click.
    rest: () => {
      resting = true
      onToken('')
      asks(false)()
      if (widget) window.turnstile?.remove(widget)
      widget = undefined
    },
    // Puts the widget back after `rest`, which starts a check. Does nothing while one is there.
    wake: () => {
      resting = false
      void show()
    },
  }
}
