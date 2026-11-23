// First: sets <html data-theme / data-density> from the saved choice before anything paints (lib/appearance.ts).
import { installAppearance } from './lib/appearance'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/figtree'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/appearance.css'
import { App } from './App'
import { installIdleAnimationPause } from './lib/idleAnimations'

installIdleAnimationPause()
installAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
