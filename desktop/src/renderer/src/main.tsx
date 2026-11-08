import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import { App } from './App'
import { installIdleAnimationPause } from './lib/idleAnimations'

installIdleAnimationPause()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
