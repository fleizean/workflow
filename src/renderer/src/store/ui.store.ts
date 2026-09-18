// Global UI state, and only that: state no single feature owns and the database never sees. Server state lives in
// TanStack Query, timer state in features/timer/state (ARCH-03).

import { create } from 'zustand';

/** The four kinds v1.2.1's toast and its alert both spoke in, kept as one vocabulary rather than two. */
export type Tone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
    readonly id: number;
    readonly tone: Tone;
    readonly message: string;
    /** Set while the exit animation runs; the row leaves the list when it has finished. */
    readonly leaving: boolean;
}

/**
 * One request shape for both an alert and a confirm: a confirm is a request that names a confirmLabel. Criterion 5
 * allows one alert implementation, so the difference between the two is data rather than a second component.
 */
export interface DialogRequest {
    readonly tone: Tone;
    /** Overrides the tone's own icon; the tone decides the colour either way. */
    readonly icon?: string;
    readonly title: string;
    readonly body: string;
    readonly dismissLabel: string;
    readonly confirmLabel?: string;
    /** Draws the confirm button as destructive. */
    readonly destructive?: boolean;
}

export interface Dialog extends DialogRequest {
    readonly id: number;
}

interface UiState {
    readonly toasts: readonly Toast[];
    /** A queue, so a second request waits rather than replacing a dialog whose caller is still awaiting an answer. */
    readonly dialogs: readonly Dialog[];
    /*
     * WR-05: how many dialogs are on screen, published by Modal because it is what marks #app-shell inert. A
     * control inside the shell cannot be clicked while this is above zero, so anything that would otherwise run
     * uncancellable has to be able to see it.
     */
    readonly modalsOpen: number;
    // Function-valued properties rather than methods: an action is selected off the store and called on its own.
    readonly pushToast: (tone: Tone, message: string) => void;
    readonly dismissToast: (id: number) => void;
    readonly removeToast: (id: number) => void;
    readonly openDialog: (request: DialogRequest) => Promise<boolean>;
    readonly closeDialog: (id: number, confirmed: boolean) => void;
    readonly setModalsOpen: (count: number) => void;
}

let nextId = 0;

// Outside the state: a resolver is not something a component renders, and putting it in the store would put a
// function nobody may call into every subscriber's snapshot.
const answers = new Map<number, (confirmed: boolean) => void>();

export const useUiStore = create<UiState>((set) => ({
    toasts: [],
    dialogs: [],
    modalsOpen: 0,

    pushToast: (tone, message) => {
        nextId += 1;
        const toast: Toast = { id: nextId, tone, message, leaving: false };
        set((state) => ({ toasts: [...state.toasts, toast] }));
    },
    dismissToast: (id) => {
        set((state) => ({
            toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast))
        }));
    },
    removeToast: (id) => {
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },

    openDialog: (request) => {
        nextId += 1;
        const dialog: Dialog = { ...request, id: nextId };
        set((state) => ({ dialogs: [...state.dialogs, dialog] }));
        return new Promise<boolean>((resolve) => { answers.set(dialog.id, resolve); });
    },
    closeDialog: (id, confirmed) => {
        const answer = answers.get(id);
        answers.delete(id);
        set((state) => ({ dialogs: state.dialogs.filter((dialog) => dialog.id !== id) }));
        // After the removal: a caller that opens the next dialog from its own continuation finds this one gone.
        answer?.(confirmed);
    },

    setModalsOpen: (count) => {
        set({ modalsOpen: count });
    }
}));
