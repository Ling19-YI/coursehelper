import type { LogLevel } from '../../shared/types';
import type { TaskControl } from './control';
import type { AnswerChannel } from './quizTypes';
import type { TikuStore } from './tiku';

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
  /** 视频是否静音（设置项，默认 true） */
  muted(): boolean;
  /** AI 答题总开关（用户可控） */
  agentEnabled(): boolean;
  /** 多模态视觉服务配置；key 为空则 Agent 不接管 */
  vision(): { baseUrl: string; apiKey: string; model: string };
  /** 是否自动处理视频播放期间的随堂题弹窗（设置项，默认关） */
  answerPopup(): boolean;
  /** 是否因「验证类」弹窗（人脸/验证码/安全验证）暂停等人工。默认 false */
  autoPauseOnVerify(): boolean;
  /** 文本搜题与截图识判共用的 AI 通道（多模态配置），弹窗与章节测验都用它 */
  visionChannel(): AnswerChannel | null;
  /** 本地题库：命中则不调 AI */
  tiku(): TikuStore | null;
  /** 交卷覆盖率闸门（0~1，0=关闭） */
  submitCoverRate(): number;
}
