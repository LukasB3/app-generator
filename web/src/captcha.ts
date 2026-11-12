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
// class `asks`. Returns a function that asks for a fresh token, since each one
// works only once.
export const mountCaptcha = (container: string, sitekey: string, onToken: (token: string) => void) => {
  let widget: string | undefined
  const asks = (now: boolean) => () => document.querySelector(container)?.classList.toggle('asks', now)
  void turnstile().then((api) => {
    widget = api.render(container, {
      sitekey,
      appearance: 'interaction-only',
      callback: onToken,
      'expired-callback': () => onToken(''),
      'before-interactive-callback': asks(true),
      'after-interactive-callback': asks(false),
    })
  })
  return () => {
    onToken('')
    window.turnstile?.reset(widget)
  }
}
