/* global navigateWithLoading */

/**
 * Bottom Navigation Component
 * Creates a mobile-style bottom navigation bar with hover effects and indicator lines
 */

function createBottomNav(currentPage) {
    const nav = document.createElement('nav');
    nav.id = 'bottomNav';
    nav.className = 'fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-surface-dark border-t border-slate-200 dark:border-slate-800';

    const navItems = [
        { page: 'index', icon: 'home', label: 'Home', href: 'index.html' },
        { page: 'companies', icon: 'business', label: 'Companies', href: 'companies.html' },
        { page: 'work-history', icon: 'history', label: 'History', href: 'work-history.html' },
        { page: 'settings', icon: 'settings', label: 'Settings', href: 'settings.html' }
    ];

    const container = document.createElement('div');
    container.className = 'max-w-md mx-auto px-7';

    const flex = document.createElement('div');
    flex.className = 'flex';

    navItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'flex-1 group';

        const link = document.createElement('a');
        link.href = '#';
        const isActive = item.page === currentPage;
        link.className = `flex items-end justify-center text-center mx-auto px-4 pt-2 w-full transition-colors duration-200 ${isActive ? 'text-primary' : 'text-gray-400 group-hover:text-primary'
            }`;
        link.setAttribute('data-page', item.page);
        link.setAttribute('aria-label', `Go to ${item.label}`);
        if (isActive) link.setAttribute('aria-current', 'page');

        const span = document.createElement('span');
        span.className = 'block px-1 pt-1 pb-1';

        // Icon
        const iconSpan = document.createElement('span');
        iconSpan.className = 'material-symbols-outlined text-2xl pt-1 mb-1 block';
        iconSpan.textContent = item.icon;
        if (isActive) {
            iconSpan.style.fontVariationSettings = "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24";
        }

        // Label
        const labelSpan = document.createElement('span');
        labelSpan.className = 'block text-xs pb-2';
        labelSpan.textContent = item.label;

        // Indicator line
        const indicator = document.createElement('span');
        indicator.className = `block w-5 mx-auto h-1 rounded-full transition-all duration-200 ${isActive ? 'bg-primary' : 'bg-transparent group-hover:bg-primary'
            }`;

        span.appendChild(iconSpan);
        span.appendChild(labelSpan);
        span.appendChild(indicator);
        link.appendChild(span);

        // Click handler
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateWithLoading(item.href);
        });

        div.appendChild(link);
        flex.appendChild(div);
    });

    container.appendChild(flex);
    nav.appendChild(container);
    document.body.appendChild(nav);

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
        /* Bottom Navigation Styles */
        #bottomNav {
            box-shadow: 0 -4px 6px -1px rgba(0, 0, 0, 0.1), 0 -2px 4px -1px rgba(0, 0, 0, 0.06);
        }
        
        /* Responsive design for larger screens */
        @media (min-width: 768px) {
            #bottomNav {
                left: 50%;
                transform: translateX(-50%);
                max-width: 430px;
                border-radius: 24px 24px 0 0;
            }
        }
    `;
    document.head.appendChild(style);
}

// Auto-initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    const currentPage = window.location.pathname.split('/').pop().replace('.html', '') || 'index';
    createBottomNav(currentPage);
});
