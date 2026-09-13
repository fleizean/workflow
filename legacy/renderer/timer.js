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

        // Pomodoro mode properties
        this.pomodoroMode = false;
        this.pomodoroState = 'work'; // 'work', 'shortBreak', 'longBreak'
        this.pomodoroSessionCount = 0;
        this.pomodoroSettings = {
            workDuration: 25 * 60,      // 25 minutes
            shortBreak: 5 * 60,         // 5 minutes
            longBreak: 15 * 60,         // 15 minutes
            sessionsUntilLongBreak: 4,
            autoStartBreaks: true,
            autoStartWork: false
        };
        this.onPomodoroComplete = null; // Callback when session completes
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

            // Check Pomodoro completion
            if (this.pomodoroMode) {
                this.checkPomodoroCompletion();
            }

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

    /**
     * Enable Pomodoro mode
     */
    enablePomodoroMode(settings) {
        this.pomodoroMode = true;
        if (settings) {
            this.pomodoroSettings = { ...this.pomodoroSettings, ...settings };
        }
        this.pomodoroState = 'work';
        this.pomodoroSessionCount = 0;
        this.reset();
    }

    /**
     * Disable Pomodoro mode
     */
    disablePomodoroMode() {
        this.pomodoroMode = false;
        this.pomodoroState = 'work';
        this.pomodoroSessionCount = 0;
        this.reset();
    }

    /**
     * Get current Pomodoro target duration
     */
    getPomodoroTarget() {
        if (!this.pomodoroMode) return null;

        switch (this.pomodoroState) {
            case 'work':
                return this.pomodoroSettings.workDuration;
            case 'shortBreak':
                return this.pomodoroSettings.shortBreak;
            case 'longBreak':
                return this.pomodoroSettings.longBreak;
            default:
                return this.pomodoroSettings.workDuration;
        }
    }

    /**
     * Check if Pomodoro session is complete
     */
    checkPomodoroCompletion() {
        if (!this.pomodoroMode || !this.running) return false;

        const target = this.getPomodoroTarget();
        if (this.elapsedSeconds >= target) {
            this.completePomodoroSession();
            return true;
        }
        return false;
    }

    /**
     * Complete current Pomodoro session
     */
    completePomodoroSession() {
        this.pause();

        if (this.pomodoroState === 'work') {
            // Work session completed
            this.pomodoroSessionCount++;

            // Determine next break type
            if (this.pomodoroSessionCount % this.pomodoroSettings.sessionsUntilLongBreak === 0) {
                this.pomodoroState = 'longBreak';
            } else {
                this.pomodoroState = 'shortBreak';
            }

            // Auto-start break if enabled
            if (this.pomodoroSettings.autoStartBreaks) {
                this.reset();
                setTimeout(() => this.start(), 1000);
            } else {
                this.reset();
            }
        } else {
            // Break completed
            this.pomodoroState = 'work';

            // Auto-start work if enabled
            if (this.pomodoroSettings.autoStartWork) {
                this.reset();
                setTimeout(() => this.start(), 1000);
            } else {
                this.reset();
            }
        }

        // Trigger callback
        if (this.onPomodoroComplete) {
            this.onPomodoroComplete(this.pomodoroState, this.pomodoroSessionCount);
        }
    }

    /**
     * Skip current break (Pomodoro mode only)
     */
    skipBreak() {
        if (!this.pomodoroMode || this.pomodoroState === 'work') return;

        this.pomodoroState = 'work';
        this.reset();
    }

    /**
     * Get Pomodoro state info
     */
    getPomodoroInfo() {
        return {
            enabled: this.pomodoroMode,
            state: this.pomodoroState,
            sessionCount: this.pomodoroSessionCount,
            target: this.getPomodoroTarget()
        };
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


