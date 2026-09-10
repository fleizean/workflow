/*
 * The renderer bootstrap - deliberately the minimum. No router and no stylesheet yet: the
 * HashRouter shell and the build-time Tailwind pipeline are plan 02-03's. This mounts one element
 * so the packaged smoke launch can prove the bundle loads and runs under the Content-Security-Policy.
 *
 * The one inline colour exists only so the word is legible against the window's dark background
 * during the manual `npm run dev` check; it goes when plan 02-03's stylesheet lands.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('src/renderer/index.html has no #root element, so there is nothing to mount into.');
}

createRoot(container).render(
    <StrictMode>
        <div style={{ color: '#ffffff' }}>Workflow</div>
    </StrictMode>
);
