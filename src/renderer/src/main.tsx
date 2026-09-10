/*
 * The renderer bootstrap: install the stylesheet, mount the routing root.
 *
 * The first import is load-bearing and must stay first. In development, @vitejs/plugin-react
 * injects its React Refresh preamble as an INLINE script in the entry document, and the
 * Content-Security-Policy's script-src 'self' blocks inline script - correctly, that is the policy
 * doing its job. Without the preamble every component module throws "can't detect preamble" in
 * dev. The virtual module below delivers the same preamble as a same-origin module instead, and it
 * must run before React or any component loads. In a production build it is an empty module. Do
 * not "fix" the dev error by loosening script-src.
 *
 * The stylesheet import is what puts Tailwind's build-time output into the bundle instead of a CDN
 * fetch.
 */

import '@vitejs/plugin-react/preamble';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
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
