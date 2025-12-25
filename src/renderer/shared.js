// src/renderer/shared.js
// Shared utilities and loading animations

/**
 * Format seconds to HHh MMm
 */
function formatTimeShort(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Get day of week and date
 */
function formatDateBadge(dateStr) {
    const date = new Date(dateStr);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
        day: days[date.getDay()],
        date: date.getDate()
    };
}

/**
 * Group sessions by week
 */
function groupSessionsByWeek(sessions) {
    const thisWeek = [];
    const lastWeek = [];

    const today = new Date();
    const dayOfWeek = today.getDay();
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    thisMonday.setHours(0, 0, 0, 0);

    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);

    const nextMonday = new Date(thisMonday);
    nextMonday.setDate(thisMonday.getDate() + 7);

    sessions.forEach(session => {
        const sessionDate = new Date(session.date);

        if (sessionDate >= thisMonday && sessionDate < nextMonday) {
            thisWeek.push(session);
        } else if (sessionDate >= lastMonday && sessionDate < thisMonday) {
            lastWeek.push(session);
        }
    });

    return { thisWeek, lastWeek };
}

/**
 * Show loading overlay
 */
function showLoadingOverlay() {
    let overlay = document.getElementById('loadingOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.className = 'loading-overlay';
        overlay.innerHTML = `
            <div class="loading-spinner">
                <svg class="spinner-svg" viewBox="0 0 50 50">
                    <circle class="spinner-circle" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
                </svg>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    // Force reflow to ensure animation plays
    overlay.offsetHeight;
    overlay.classList.add('active');
}

/**
 * Hide loading overlay
 */
function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        // Remove after animation completes
        setTimeout(() => {
            if (!overlay.classList.contains('active')) {
                overlay.remove();
            }
        }, 300);
    }
}

/**
 * Show toast notification
 */
function showToast(message, type = 'info', duration = 3000) {
    // Create toast container if it doesn't exist
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const iconMap = {
        info: { icon: 'info', color: 'bg-blue-500' },
        error: { icon: 'error', color: 'bg-red-500' },
        warning: { icon: 'warning', color: 'bg-orange-500' },
        success: { icon: 'check_circle', color: 'bg-green-500' }
    };
    const config = iconMap[type] || iconMap.info;

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.innerHTML = `
        <div class="flex items-center gap-3 ${config.color} text-white px-4 py-3 rounded-xl shadow-lg">
            <span class="material-symbols-outlined text-xl">${config.icon}</span>
            <span class="text-sm font-medium flex-1">${message}</span>
            <button class="toast-close opacity-70 hover:opacity-100 transition">
                <span class="material-symbols-outlined text-lg">close</span>
            </button>
        </div>
    `;

    container.appendChild(toast);

    // Close button
    toast.querySelector('.toast-close').addEventListener('click', () => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    });

    // Auto dismiss
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);

    // Animate in
    setTimeout(() => toast.classList.add('toast-show'), 10);
}

/**
 * Navigate with loading animation
 */
async function navigateWithLoading(page) {
    showLoadingOverlay();

    // Small delay to show loading animation
    await new Promise(resolve => setTimeout(resolve, 150));

    await window.api.navigateTo({ page });
}

/**
 * Create modern modal with consistent styling
 * @param {Object} options - Modal configuration
 * @param {string} options.icon - Material icon name
 * @param {string} options.title - Modal title
 * @param {string} options.description - Optional description text
 * @param {string} options.content - HTML content for modal body
 * @param {string} options.iconColor - Icon background gradient (default: blue)
 * @returns {HTMLElement} Modal element
 */
function createModernModal({ icon, title, description = '', content, iconColor = 'from-blue-900/50 to-primary/20' }) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm px-4';

    modal.innerHTML = `
        <div class="relative w-full max-w-sm bg-surface-dark rounded-3xl shadow-2xl border border-white/10 overflow-hidden transform transition-all">
            <div class="px-6 pt-8 pb-4 flex flex-col items-center justify-center text-center">
                <div class="w-14 h-14 rounded-full bg-gradient-to-tr ${iconColor} flex items-center justify-center mb-4 shadow-inner ring-1 ring-white/10">
                    <span class="material-symbols-outlined text-primary text-3xl">${icon}</span>
                </div>
                <h2 class="text-2xl font-bold text-white tracking-tight">${title}</h2>
                ${description ? `<p class="text-sm text-gray-400 mt-2 font-medium">${description}</p>` : ''}
            </div>
            ${content}
        </div>
    `;

    return modal;
}

// Add loading and toast styles to document
if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.textContent = `
        .loading-overlay {
            position: fixed;
            inset: 0;
            background-color: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(4px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease-in-out;
        }

        .loading-overlay.active {
            opacity: 1;
            pointer-events: all;
        }

        .loading-spinner {
            width: 60px;
            height: 60px;
        }

        .spinner-svg {
            animation: rotate 1.4s linear infinite;
            width: 100%;
            height: 100%;
        }

        .spinner-circle {
            stroke: #13a4ec;
            stroke-linecap: round;
            animation: dash 1.4s ease-in-out infinite;
        }

        @keyframes rotate {
            100% {
                transform: rotate(360deg);
            }
        }

        @keyframes dash {
            0% {
                stroke-dasharray: 1, 150;
                stroke-dashoffset: 0;
            }
            50% {
                stroke-dasharray: 90, 150;
                stroke-dashoffset: -35;
            }
            100% {
                stroke-dasharray: 90, 150;
                stroke-dashoffset: -124;
            }
        }

        /* Toast Notifications */
        .toast-container {
            position: fixed;
            top: 1rem;
            right: 1rem;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            max-width: 400px;
            pointer-events: none;
        }

        .toast-notification {
            pointer-events: all;
            transform: translateX(400px);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }

        .toast-notification.toast-show {
            transform: translateX(0);
            opacity: 1;
        }

        .toast-notification.toast-fade-out {
            transform: translateX(400px);
            opacity: 0;
        }

        .toast-close {
            background: transparent;
            border: none;
            cursor: pointer;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
    `;
    document.head.appendChild(style);
}
