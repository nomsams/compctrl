import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './app/globals.css';
import Home from './app/page';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);

if ('serviceWorker' in navigator && !window.compCtrl) {
  window.addEventListener('load', () => {
    const scopeUrl = new URL('./', document.baseURI);
    void navigator.serviceWorker.register(new URL('sw.js', scopeUrl), { scope: scopeUrl.pathname });
  });
}
