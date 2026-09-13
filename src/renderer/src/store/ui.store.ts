// Global UI state, and only that: state no single feature owns and the database never sees. Server state lives in
// TanStack Query, timer state in features/timer/state (ARCH-03).

import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
    readonly id: number;
    readonly kind: ToastKind;
    readonly message: string;
}

interface UiState {
    readonly toasts: readonly Toast[];
    // Function-valued properties rather than methods: an action is selected off the store and called on its own.
    readonly pushToast: (kind: ToastKind, message: string) => void;
    readonly dismissToast: (id: number) => void;
}

let nextToastId = 0;

export const useUiStore = create<UiState>((set) => ({
    toasts: [],
    pushToast: (kind, message) => {
        nextToastId += 1;
        const toast: Toast = { id: nextToastId, kind, message };
        set((state) => ({ toasts: [...state.toasts, toast] }));
    },
    dismissToast: (id) => {
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }
}));
