// renderer/timer.js
// Timer logic for Workflow

/* eslint-disable no-unused-vars */
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
    // Use local date instead of UTC
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
    // 24-hour format
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}


