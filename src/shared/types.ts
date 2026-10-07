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
}

export const DEFAULT_SETTINGS: AppSettings = {
  deepseekKey: '',
  autoResume: true,
  startMinimized: false,
  dataDir: '',
};
