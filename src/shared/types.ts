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
  | 'skipped'
  /** 没能进入该任务点（目录里找不到 / frame 丢失），未做任何处理 */
  | 'enter_failed'
  /**
   * 中途被用户手动切走（或平台自己跳到了别的章节）。
   * 不是失败也不是完成——本节未做完，引擎已让位、改从用户点开的那一节继续。
   */
  | 'user_switched';

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
  /**
   * 这份进度属于哪个账号。
   *
   * 同一门课可能被多个账号选修（同一 courseId），而进度文件只按 courseId 存。
   * 不记账号的话，换账号后会拿别人的完成记录去跳过章节，表现为「换了账号
   * 任务点一个都不刷」。老数据没有这个字段，按「不认账、沿用」处理，
   * 不做破坏性迁移。
   */
  account?: string;
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
  autoResume: boolean;
  startMinimized: boolean;
  dataDir: string;
  /** 视频倍速：1 / 1.25 / 1.5 / 2 */
  videoSpeed: number;
  /** 视频静音：默认开启，刷课时无需出声 */
  muted: boolean;
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
  /**
   * 遇到「验证类」弹窗时是否暂停一切模拟动作、等人工处理。
   *
   * 覆盖人脸识别 / 验证码 / 安全验证三类。**默认关闭**：
   * 这三类的识别误判代价太高——课程正文就含这些词（人工智能课的正文里
   * 就有「人脸识别」），误判一次会让整轮刷课停摆在等人，且日志看不出所以然。
   * 关闭后引擎照常跑，真遇到验证码会因视频停滞被 StallGuard 判为 stuck 并跳过，
   * 不会无限等。
   *
   * 扫码不在这个开关范围内，始终暂停：引擎一旦继续动作，二维码会被平台判定
   * 为环境变化而反复刷新，用户永远扫不上。
   */
  autoPauseOnVerify: boolean;
  /** 多模态接口地址（OpenAI 兼容）。留空 = 未配置，需用户自行填写 */
  visionBaseUrl: string;
  /** 多模态模型名 */
  visionModel: string;
  /** 窗口上次关闭时的位置与大小；空表示用默认值 */
  windowBounds: { x?: number; y?: number; width: number; height: number; maximized?: boolean } | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoResume: true,
  startMinimized: false,
  dataDir: '',
  videoSpeed: 1,
  muted: true,
  agentEnabled: false,
  answerPopup: false,
  autoPauseOnVerify: false,
  submitCoverRate: 0.8,
  // 不预置任何接口地址：默认指向某个具体服务商，等于把公开版本的用户
  // 导到那一家里去（还是对方付费的）。地址和 key 都该由使用者自己填。
  visionBaseUrl: '',
  // 视觉模型名完全由用户决定，这里只是给个能用的默认值。
  // 唯一要求是支持 OpenAI 兼容的 chat/completions + image_url（原生多模态）。
  // 实测可用：mimo-v2.5 / mimo-v2.6-flash / qwen3-vl-plus / glm-4.6v / glm-5v-turbo；
  // deepseek-v4-pro 之类纯文本模型不吃图，会返回空答案。
  visionModel: 'mimo-v2.5',
  windowBounds: null,
};
