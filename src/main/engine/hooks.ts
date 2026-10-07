import type { LogLevel } from '../../shared/types';
import type { TaskControl } from './control';

export interface TickInfo {
  ct: number;
  d: number;
  paused: boolean;
  rate: number;
}

export interface EngineHooks {
  ctl: TaskControl;
  log(level: LogLevel, msg: string): void;
  onTick(s: TickInfo): void;
  diag(tag: string): Promise<string | null>;
}
