import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App.tsx';

if (import.meta.env.DEV && typeof window !== 'undefined' && !window.crossOriginIsolated) {
  // mp4box.js uses SharedArrayBuffer for sample parsing, which requires
  // crossOriginIsolated (COOP=same-origin + COEP=require-corp). Without it
  // export decoder setup fails opaquely.
  console.warn(
    '[aether] crossOriginIsolated=false — COOP/COEP headers not active. ' +
      'Check vite.config.ts server.headers and any external resources loaded from index.html/globals.css.'
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
