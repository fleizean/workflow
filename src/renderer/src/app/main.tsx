/*
 * The renderer bootstrap: install the stylesheet, mount the composition root.
 *
 * The first import is load-bearing and must stay first. In development @vitejs/plugin-react injects its React
 * Refresh preamble as an INLINE script, which the CSP's script-src 'self' blocks - correctly. Without the preamble
 * every component module throws "can't detect preamble" in dev. The virtual module below delivers the same
 * preamble as a same-origin module and must run before React loads; in production it is empty. Do not "fix" the
 * dev error by loosening script-src.
 */

import '@vitejs/plugin-react/preamble';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';
import App from './App';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('src/renderer/index.html has no #root element, so there is nothing to mount into.');
}

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>
);
