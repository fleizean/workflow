// renderer/timer.js
// Timer logic for Workflow Timer

class WorkTimer {
    constructor() {
        this.running = false;
        this.startTime = null;
        this.elapsedSeconds = 0;
        this.interval = null;
        this.onUpdate = null; // Callback for UI updates
    }

    /**
     * Start the timer
     */
    start() {
        if (this.running) return;

        this.running = true;
        this.startTime = Date.now() - (this.elapsedSeconds * 1000);

        this.interval = setInterval(() => {
            this.elapsedSeconds = Math.floor((Date.now() - this.startTime) / 1000);
            if (this.onUpdate) {
                this.onUpdate(this.elapsedSeconds);
            }
        }, 1000);
    }

    /**
     * Pause the timer
     */
    pause() {
        if (!this.running) return;

        this.running = false;
        clearInterval(this.interval);
        this.interval = null;
    }

    /**
     * Reset the timer
     */
    reset() {
        this.pause();
        this.elapsedSeconds = 0;
        if (this.onUpdate) {
            this.onUpdate(0);
        }
    }

    /**
     * Add seconds to the timer
     */
    addSeconds(seconds) {
        this.elapsedSeconds += seconds;
        if (this.elapsedSeconds < 0) {
            this.elapsedSeconds = 0;
        }

        if (this.running) {
            this.startTime = Date.now() - (this.elapsedSeconds * 1000);
        }

        if (this.onUpdate) {
            this.onUpdate(this.elapsedSeconds);
        }
    }

    /**
     * Get elapsed seconds
     */
    getElapsed() {
        return this.elapsedSeconds;
    }

    /**
     * Check if timer is running
     */
    isRunning() {
        return this.running;
    }
}

/**
 * Format seconds to HH:MM:SS
 */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Format seconds to HHh MMm
 */
function formatTimeShort(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Calculate progress percentage
 */
function calculateProgress(elapsed, target) {
    return Math.min(100, (elapsed / target) * 100);
}

/**
 * Get current date in YYYY-MM-DD format
 */
function getCurrentDate() {
    const now = new Date();
    return now.toISOString().split('T')[0];
}

/**
 * Get current time in HH:MM format
 */
function getCurrentTime() {
    const now = new Date();
    return now.toTimeString().split(':').slice(0, 2).join(':');
}

/**
 * Calculate estimated finish time
 */
function calculateFinishTime(remainingSeconds) {
    const now = new Date();
    const finish = new Date(now.getTime() + remainingSeconds * 1000);
    const hours = finish.getHours();
    const minutes = finish.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${ampm}`;
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
