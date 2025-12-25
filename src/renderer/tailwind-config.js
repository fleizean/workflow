// src/renderer/tailwind-config.js - Ortak Tailwind konfigürasyonu

// Tailwind config'i global olarak set et
if (typeof tailwind !== 'undefined') {
    tailwind.config = {
        darkMode: "class",
        theme: {
            extend: {
                colors: {
                    "primary": "#13a4ec",
                    "background-light": "#f6f7f8",
                    "background-dark": "#101c22",
                    "card-light": "#ffffff",
                    "card-dark": "#1a2c35",
                    "surface-dark": "#1c2a33",
                },
                fontFamily: {
                    "display": ["Inter", "sans-serif"]
                },
                borderRadius: {
                    "DEFAULT": "0.25rem",
                    "lg": "0.5rem",
                    "xl": "0.75rem",
                    "2xl": "1rem",
                    "full": "9999px"
                },
            },
        },
    };
}
