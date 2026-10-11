/*
 * PANEL-02: the panel's two ways out of itself. 'open' is the footer; 'save' is what the Stop the panel does not
 * have would be - it raises the main window with the save form, because recording work needs a company and a note
 * and the save is one atomic call main owns (WR-06).
 *
 * Neither invalidates anything: main announces what a successful call changed on `data:changed`, and neither of
 * these changes anything the renderer caches.
 */

import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import { invoke } from '@renderer/lib/ipc';
import type { MainWindowIntent } from '@shared/types';

export function useShowMainWindow(): UseMutationResult<void, Error, MainWindowIntent> {
    return useMutation({
        mutationFn: (intent: MainWindowIntent): Promise<void> => invoke('window:showMain', { intent })
    });
}
