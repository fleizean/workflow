// Vite `?raw` imports: migration SQL travels as a bundled string, never a runtime fs read or asar path (D-08).

declare module '*.sql?raw' {
    const sql: string;
    export default sql;
}
