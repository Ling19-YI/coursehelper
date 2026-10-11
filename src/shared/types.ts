export interface Course {
  index: number;
  name: string;
  url: string;
  courseId: string;
}

export type TaskState =
  | 'idle'
  | 'starting'
  | 'login'
  | 'listing'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'stopped';

export type ChapterResult =
  | 'completed'
  | 'doc_done'
  | 'no_video'
  | 'stuck'
  | 'unexpected'
  | 'quiz_ok'
  | 'quiz_skip'
  | 'error'
  | 'skipped';

export type LogLevel = 'info' | 'warn' | 'error' | 'ok';

export type EngineEvent =
  | { type: 'log'; level: LogLevel; msg: string; ts: number }
  | { type: 'state'; state: TaskState; detail?: string; ts: number }
  | { type: 'courses'; courses: Course[]; ts: number }
  | {
      type: 'course-progress';
      courseId: string;
      courseName: string;
      completed: number;
      total: number;
      lastChapter?: string;
      ts: number;
    }
  | { type: 'video'; ct: number; d: number; paused: boolean; rate: number; chapter: string; ts: number }
  | { type: 'chapter'; index: number; total: number; name: string; result: ChapterResult; ts: number }
  | { type: 'task-done'; completed: number; skipped: number; ts: number }
  | { type: 'error'; message: string; ts: number };

export interface CourseProgress {
  courseId: string;
  courseName: string;
  completedChapters: string[];
  lastChapter: string;
  updatedAt: number;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface RunOptions {
  resume: boolean;
}

export interface RunSummary {
  completed: number;
  skipped: number;
}

export interface AppSettings {
  deepseekKey: string;
  autoResume: boolean;
  startMinimized: boolean;
  dataDir: string;
  /** 视频倍速：1 / 1.25 / 1.5 / 2 */
  videoSpeed: number;
  /** AI 答题总开关 */
  agentEnabled: boolean;
  /**
   * 交卷前要求的最低答案覆盖率（0~1）。
   * 低于该值就不交卷，只留给人核对 —— 搜不全硬交等于把确定的错题一起交上。
   * 0 = 关闭闸门。
   */
  submitCoverRate: number;
  /**
   * 是否自动回答视频播放期间的随堂题弹窗。
   * 默认关闭：弹窗出现时视频通常已暂停，自动介入会让「卡住」与「该答题」难以区分。
   */
  answerPopup: boolean;
  /** 多模态接口地址（OpenAI 兼容） */
  visionBaseUrl: string;
  /** 多模态模型名 */
  visionModel: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  deepseekKey: '',
  autoResume: true,
  startMinimized: false,
  dataDir: '',
  videoSpeed: 1,
  agentEnabled: false,
  answerPopup: false,
  submitCoverRate: 0.8,
  visionBaseUrl: 'https://tokendance.space/gateway/v1',
  // 必须是网关模型列表里真实存在的**多模态**模型。mimo-v2.6-flash 带图请求
  // 直接 500，截图识题会全部失败；mimo-v2.5 是原生全模态，实测可用。
  visionModel: 'mimo-v2.5',
};
