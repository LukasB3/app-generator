// One Cloudflare Turnstile widget per page. `onToken` gets each solved token,
// and an empty string when one expires. Returns a function that asks for a
// fresh token, since each one works only once.
export const mountCaptcha = (container: string, sitekey: string, onToken: (token: string) => void) => {
  let widget: string | undefined
  window.onTurnstileLoad = () => {
    widget = window.turnstile!.render(container, { sitekey, callback: onToken, 'expired-callback': () => onToken('') })
  }
  const script = document.createElement('script')
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad'
  script.async = true
  document.head.append(script)
  return () => {
    onToken('')
    window.turnstile?.reset(widget)
  }
}
