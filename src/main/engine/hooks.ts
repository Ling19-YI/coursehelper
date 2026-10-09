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
  /** 目标视频倍速（1 / 1.25 / 1.5 / 2） */
  speed(): number;
  /** AI 答题总开关（用户可控） */
  agentEnabled(): boolean;
  /** 多模态视觉服务配置；key 为空则 Agent 不接管 */
  vision(): { baseUrl: string; apiKey: string; model: string };
}
