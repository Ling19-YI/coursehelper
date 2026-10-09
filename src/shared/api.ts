import type { AppSettings, Course, CourseProgress, EngineEvent, TaskState } from './types';

export interface AppInfo {
  version: string;
  userData: string;
  dataDir: string;
  legacy?: boolean;
}

export interface UpdateState {
  checking: boolean;
  available: boolean;
  version?: string;
  notes?: string;
  releaseDate?: string;
  percent: number;
  speed: number;
  transferred: number;
  total: number;
  downloading: boolean;
  message: string;
}

export interface Api {
  onEngineEvent(cb: (e: EngineEvent) => void): () => void;
  getState(): Promise<{ state: TaskState; running: boolean; mode: string | null }>;
  getProgress(): Promise<CourseProgress[]>;
  listCourses(): Promise<Course[]>;
  start(courseIds: string[], resume: boolean): Promise<{ ok: boolean }>;
  pause(): void;
  resume(): void;
  stop(): void;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getUsername(): Promise<string | null>;
  setCredentials(username: string, password: string): Promise<void>;
  clearCredentials(): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  /** 视觉服务配置状态（只回传掩码提示，不回传完整 key） */
  getVision(): Promise<{ configured: boolean; hint: string }>;
  setVision(key: string): Promise<{ configured: boolean }>;
  /** 自动更新 */
  checkUpdate(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<boolean>;
  getUpdateState(): Promise<UpdateState>;
  onUpdateEvent(cb: (s: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    ch: Api;
  }
}
