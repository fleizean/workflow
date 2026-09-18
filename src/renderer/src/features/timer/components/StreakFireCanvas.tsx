/*
 * The brushstroke fire behind the streak card at tiers 2 and 3 - legacy/pages/index.html:596-700's
 * StreakFireAnimation, as a component. The palette, the particle counts, the speeds, the lifespans and the
 * brushstroke path are carried over unchanged.
 *
 * Three things the v1.2.1 class did not do, all of them Phase 10 criterion 4 and all of them cheaper to do here
 * than to come back for:
 *  - it sized the bitmap in CSS pixels, so on a 150% display the canvas drew at two thirds of the resolution it was
 *    painted at and the flame was soft;
 *  - it never resized, so a window drag left the bitmap at the old size and the drawing stretched;
 *  - it cancelled its frame loop only when another tier replaced it, never on teardown, so navigating away from the
 *    screen left requestAnimationFrame running for the life of the process.
 */

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

export type FireIntensity = 'medium' | 'high';

interface Rgb { readonly r: number; readonly g: number; readonly b: number }

const PALETTE: readonly Rgb[] = [
    { r: 245, g: 167, b: 66 },
    { r: 232, g: 90, b: 25 },
    { r: 255, g: 62, b: 0 },
    { r: 191, g: 34, b: 34 }
];

const PARTICLE_COUNT: Record<FireIntensity, number> = { medium: 30, high: 50 };
const MAX_EXTRA_SIZE: Record<FireIntensity, number> = { medium: 8, high: 12 };
const MAX_RISE: Record<FireIntensity, number> = { medium: 1.2, high: 2 };
/** v1.2.1 divided the remaining lifespan by this fixed number rather than by the particle's own span. */
const FADE_SPAN = 200;

interface Particle {
    x: number;
    y: number;
    size: number;
    opacity: number;
    speedX: number;
    speedY: number;
    colorIndex: number;
    rotation: number;
    rotationSpeed: number;
    sway: number;
    swaySpeed: number;
    swayOffset: number;
    lifespan: number;
}

function createParticle(width: number, height: number, intensity: FireIntensity): Particle {
    return {
        x: Math.random() * width,
        y: height + Math.random() * 20,
        size: 3 + Math.random() * MAX_EXTRA_SIZE[intensity],
        opacity: 0.2 + Math.random() * 0.4,
        speedX: (Math.random() - 0.5) * 0.8,
        speedY: -0.8 - Math.random() * MAX_RISE[intensity],
        colorIndex: Math.floor(Math.random() * PALETTE.length),
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.03,
        sway: 0.2 + Math.random() * 0.4,
        swaySpeed: 0.01 + Math.random() * 0.02,
        swayOffset: Math.random() * Math.PI * 2,
        lifespan: 80 + Math.random() * 120
    };
}

function rgba(color: Rgb, alpha: number): string {
    return 'rgba(' + String(color.r) + ', ' + String(color.g) + ', ' + String(color.b) + ', ' + String(alpha) + ')';
}

function drawBrushstroke(
    context: CanvasRenderingContext2D,
    particle: Particle,
    size: number,
    opacity: number,
    color: Rgb
): void {
    context.save();
    context.translate(particle.x, particle.y);
    context.rotate(particle.rotation);

    const gradient = context.createLinearGradient(0, -size, 0, size);
    gradient.addColorStop(0, rgba(color, 0));
    gradient.addColorStop(0.5, rgba(color, opacity));
    gradient.addColorStop(1, rgba(color, 0));
    context.fillStyle = gradient;

    context.beginPath();
    context.moveTo(-size / 3, -size);
    context.quadraticCurveTo(size / 2, 0, -size / 3, size);
    context.quadraticCurveTo(size / 2, 0, size / 3, -size / 2);
    context.closePath();
    context.fill();

    context.fillStyle = rgba(color, opacity * 0.6);
    context.beginPath();
    context.ellipse(size / 6, 0, size / 4, size / 2, 0, 0, Math.PI * 2);
    context.fill();

    context.restore();
}

/*
 * h-full w-full is load-bearing, not tidiness. A canvas is a REPLACED element with an intrinsic size - the
 * width and height content attributes, which default to 300x150 - so `inset-0` alone never stretched it: for an
 * absolutely positioned replaced element, `width: auto` resolves to the intrinsic width and the `right` offset is
 * then simply ignored. The flame has therefore always been drawn 300x150 inside a card about a third that wide,
 * with `overflow-hidden` on the card cropping it to its top-left corner, and resize() measured that 300x150 and
 * wrote it straight back - so the bitmap tracked the ATTRIBUTE rather than the card, at every window size and
 * every display scale. Two CSS lengths override the intrinsic size and the box finally follows the card.
 * Measured by tools/baseline/responsive-matrix.mjs, which found it as a 300px-wide element hanging 174px past
 * the right edge of a 380px window.
 */
const CANVAS_CLASS = 'absolute inset-0 h-full w-full pointer-events-none rounded-2xl';

export default function StreakFireCanvas({ intensity }: { readonly intensity: FireIntensity }): ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext('2d');
        if (canvas === null || context === null || context === undefined) {
            return undefined;
        }

        let width = 0;
        let height = 0;
        let particles: Particle[] = [];
        let time = 0;
        let frame = 0;

        // The bitmap is in device pixels and the drawing stays in CSS pixels, so the flame is sharp at 125% and
        // 150% display scaling and redraws at the right size after a window resize (Phase 10 criterion 4).
        const resize = (): void => {
            const box = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
            width = box.width;
            height = box.height;
            canvas.width = Math.max(1, Math.round(width * ratio));
            canvas.height = Math.max(1, Math.round(height * ratio));
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
        };

        resize();
        particles = Array.from(
            { length: PARTICLE_COUNT[intensity] },
            () => createParticle(width, height, intensity)
        );

        const step = (): void => {
            context.clearRect(0, 0, width, height);
            time += 0.02;

            for (let index = 0; index < particles.length; index++) {
                const particle = particles[index];
                if (particle === undefined) {
                    continue;
                }
                particle.x += particle.speedX + Math.sin(time * particle.swaySpeed + particle.swayOffset) * particle.sway;
                particle.y += particle.speedY;
                particle.rotation += particle.rotationSpeed;
                particle.lifespan -= 1;

                const life = particle.lifespan / FADE_SPAN;
                const color = PALETTE[particle.colorIndex];
                if (particle.lifespan > 0 && color !== undefined) {
                    drawBrushstroke(context, particle, particle.size * life, particle.opacity * life, color);
                }
                if (particle.lifespan <= 0 || particle.y < -50) {
                    particles[index] = createParticle(width, height, intensity);
                }
            }

            frame = requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);

        /*
         * A ResizeObserver fires on a CSS-size change and on nothing else, so dragging the window onto a monitor at
         * a different Windows display scale changes devicePixelRatio while the card stays exactly as many CSS
         * pixels wide - and the bitmap would keep the old ratio, which is the soft flame this component exists to
         * fix. A resolution media query is the one thing that reports that transition; it resolves against the
         * current ratio, so it is re-armed after every change.
         */
        let scaleQuery: MediaQueryList | undefined;
        const watchScale = (): void => {
            scaleQuery?.removeEventListener('change', onScaleChange);
            scaleQuery = window.matchMedia('(resolution: ' + String(window.devicePixelRatio) + 'dppx)');
            scaleQuery.addEventListener('change', onScaleChange);
        };
        function onScaleChange(): void {
            resize();
            watchScale();
        }
        watchScale();

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            scaleQuery?.removeEventListener('change', onScaleChange);
        };
    }, [intensity]);

    return <canvas ref={canvasRef} aria-hidden="true" className={CANVAS_CLASS} />;
}
