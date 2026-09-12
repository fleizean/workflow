// The narrow interfaces the services depend on. No Electron and no Node built-in reaches this directory: a port is
// what a service needs, stated without saying who provides it. src/main/adapters holds the implementations.

export { localDayOf } from './clock.port';
export type { ClockPort } from './clock.port';
export type { NotificationRequest, NotifierPort } from './notifier.port';
export type { RendererBusPort } from './renderer-bus.port';
export type { RepeatingTimer, SchedulerPort } from './scheduler.port';
export type { SoundPort } from './sound.port';

import type { ClockPort } from './clock.port';
import type { NotifierPort } from './notifier.port';
import type { RendererBusPort } from './renderer-bus.port';
import type { SchedulerPort } from './scheduler.port';
import type { SoundPort } from './sound.port';

/** Everything a service may reach the outside world through; the container supplies exactly this. */
export interface AppPorts {
    readonly clock: ClockPort;
    readonly notifier: NotifierPort;
    readonly sound: SoundPort;
    readonly bus: RendererBusPort;
    readonly scheduler: SchedulerPort;
}
