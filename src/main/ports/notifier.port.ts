// A system notification. v1.2.1 raised one from the renderer, which cannot fire while the window is hidden in the
// tray; main raises it instead, and the service that decides when stays free of Electron.

export interface NotificationRequest {
    readonly title: string;
    readonly body: string;
}

export interface NotifierPort {
    /** Best effort: a platform that will not show a notification is not an error the caller has to handle. */
    notify(request: NotificationRequest): void;
}
