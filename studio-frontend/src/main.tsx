import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/outfit/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'
import 'highlight.js/styles/night-owl.css'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './error-boundary.tsx'
import { TooltipProvider } from '@/components/ui/tooltip'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <TooltipProvider delay={300}>
        <App />
      </TooltipProvider>
    </AppErrorBoundary>
  </StrictMode>,
)
