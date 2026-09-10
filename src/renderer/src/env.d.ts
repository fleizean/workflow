/*
 * Vite's client types: module declarations for the stylesheet and asset imports the renderer
 * makes, plus import.meta.env. tsconfig.web.json sets `types: []` so nothing ambient leaks in by
 * accident; this reference is the one deliberate exception.
 */
/// <reference types="vite/client" />
