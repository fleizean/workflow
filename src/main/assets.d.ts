// electron-vite copies a ?asset import into the build output and hands the main process its path on disk.
// Declared here rather than by widening tsconfig.node.json's types to all of electron-vite/node.
declare module '*.png?asset' {
    const assetPath: string;
    export default assetPath;
}
