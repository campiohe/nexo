// Pauses CSS animations while the Nexo window isn't focused (styles/app.css: html.is-inactive).
//
// Any endless animation on screen (the LIVE badge's pulsing dot, a spinner, typing dots) makes Chromium draw a
// new frame on every display refresh. On NVIDIA, each of those frames spins a CPU core in Nexo's GPU process
// while it waits for the compositor (measured: one 5 px pulsing dot = ~40% of a core, ~100% in a real session).
// The window keeps rendering when covered, because backgroundThrottling is off for voice (main/index.ts), so that
// core was taken from the game for as long as you played. While a game has focus, Nexo doesn't: pause them all.

export function installIdleAnimationPause(): void {
  const root = document.documentElement
  const sync = (): void => {
    root.classList.toggle('is-inactive', !document.hasFocus() || document.visibilityState === 'hidden')
  }
  window.addEventListener('focus', sync)
  window.addEventListener('blur', sync)
  document.addEventListener('visibilitychange', sync)
  sync()
}
