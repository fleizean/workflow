/**
 * Reusable Titlebar Component
 * This creates a consistent titlebar with window controls across all pages
 */

function createTitlebar() {
    const titlebar = document.createElement('div');
    titlebar.className = 'titlebar flex items-center justify-between px-4 pt-2 pb-2 bg-background-light dark:bg-background-dark border-b border-slate-200 dark:border-slate-800';
    titlebar.innerHTML = `
        <div class="flex-1">
            <div class="flex items-center gap-2">
                <img src="../assets/icon.png" class="w-6 h-6" alt="Logo">
            </div>
        </div>
        <div class="flex items-center gap-1">
            <button onclick="window.api.minimizeWindow()" class="minimize-btn flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-r border-slate-200 dark:border-slate-800">
                <span class="material-symbols-outlined text-[18px]">minimize</span>
            </button>
            <button onclick="window.api.closeWindow()" class="close-btn flex items-center justify-center w-8 h-8 rounded-md text-slate-500 dark:text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors border-r border-slate-200 dark:border-slate-800">
                <span class="material-symbols-outlined text-[18px]">close</span>
            </button>
        </div>
    `;
    return titlebar;
}

// Auto-insert titlebar if .app-container exists
document.addEventListener('DOMContentLoaded', () => {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
        appContainer.insertBefore(createTitlebar(), appContainer.firstChild);
    }
});
