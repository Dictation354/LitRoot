import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ApplicationErrorBoundary } from './ErrorBoundary'
import 'katex/dist/katex.min.css'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('LitRoot renderer root is missing')
}

createRoot(root).render(
  <StrictMode>
    <ApplicationErrorBoundary>
      <App />
    </ApplicationErrorBoundary>
  </StrictMode>
)
