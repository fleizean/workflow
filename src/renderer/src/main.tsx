/*
 * The renderer bootstrap - deliberately the minimum. It mounts one element so the packaged smoke
 * launch can prove the bundle loads and runs under the Content-Security-Policy.
 *
 * The stylesheet import below is what puts Tailwind's build-time output into the bundle instead of
 * a CDN fetch. The HashRouter shell replaces the placeholder element in the next step.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('src/renderer/index.html has no #root element, so there is nothing to mount into.');
}

createRoot(container).render(
    <StrictMode>
        <div className="font-display dark:text-white">Workflow</div>
    </StrictMode>
);
