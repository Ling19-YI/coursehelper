import type { AppSettings, Course, CourseProgress, EngineEvent, TaskState } from './types';

export interface LicenseInfo {
  codeId: string;
  activatedAt: number;
  machineId: string;
}

export interface ActivateResult {
  ok: boolean;
  message: string;
  info?: LicenseInfo;
}

export interface AppInfo {
  version: string;
  userData: string;
  dataDir: string;
  legacy?: boolean;
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
  activate(code: string): Promise<ActivateResult>;
  licenseInfo(): Promise<LicenseInfo | null>;
  machineId(): Promise<string>;
  getAppInfo(): Promise<AppInfo>;
}

declare global {
  interface Window {
    ch: Api;
  }
}
