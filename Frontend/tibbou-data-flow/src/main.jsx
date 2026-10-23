import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
// Bundled with the app rather than loaded from Google Fonts.
import '@fontsource-variable/figtree'
import '@fontsource/source-code-pro/400.css'
import '@fontsource/source-code-pro/500.css'
import '@fontsource/source-code-pro/600.css'
import '@/index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
