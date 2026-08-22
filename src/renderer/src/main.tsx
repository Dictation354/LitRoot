import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'katex/dist/katex.min.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('PaperRelay renderer root is missing')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
