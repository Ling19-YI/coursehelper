import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AppSettings, Course, CourseProgress, EngineEvent, TaskState } from '../shared/types';
import type { AppInfo } from '../shared/api';

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'ok';
  msg: string;
}

export interface PlatformProgress {
  completed: number;
  total: number;
}

export interface AppCtxType {
  info: AppInfo | null;
  settings: AppSettings | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  username: string | null;
  saveCredentials: (u: string, p: string) => Promise<void>;
  clearCredentials: () => Promise<void>;
  courses: Course[] | null;
  loadingCourses: boolean;
  refreshCourses: () => Promise<void>;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  resume: boolean;
  setResume: React.Dispatch<React.SetStateAction<boolean>>;
  engineState: TaskState;
  detail: string | null;
  video: { chapter: string; ct: number; d: number; paused: boolean } | null;
  chapter: { index: number; total: number; name: string; result: string } | null;
  platformProg: Record<string, PlatformProgress>;
  storedProg: CourseProgress[];
  logs: LogEntry[];
  clearLogs: () => void;
  summary: { completed: number; skipped: number };
  start: () => Promise<void>;
  pause: () => void;
  resumeRun: () => void;
  stop: () => void;
  page: string;
  setPage: (p: string) => void;
}

const Ctx = createContext<AppCtxType>(null as unknown as AppCtxType);
export const useApp = () => useContext(Ctx);

const ch = () => window.ch;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [resume, setResume] = useState(true);
  const [engineState, setEngineState] = useState<TaskState>('idle');
  const [detail, setDetail] = useState<string | null>(null);
  const [video, setVideo] = useState<AppCtxType['video']>(null);
  const [chapter, setChapter] = useState<AppCtxType['chapter']>(null);
  const [platformProg, setPlatformProg] = useState<Record<string, PlatformProgress>>({});
  const [storedProg, setStoredProg] = useState<CourseProgress[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState({ completed: 0, skipped: 0 });
  const [page, setPage] = useState('dashboard');

  const refreshCourses = useCallback(async () => {
    setLoadingCourses(true);
    try {
      setCourses(await ch().listCourses());
    } finally {
      setLoadingCourses(false);
    }
  }, []);

  const onEvent = useCallback((e: EngineEvent) => {
    switch (e.type) {
      case 'log':
        setLogs(l => [...l.slice(-599), { ts: e.ts, level: e.level, msg: e.msg }]);
        break;
      case 'state':
        setEngineState(e.state);
        setDetail(e.detail ?? null);
        if (e.state === 'idle' || e.state === 'done' || e.state === 'stopped') {
          setVideo(null);
          setChapter(null);
        }
        break;
      case 'courses':
        setCourses(e.courses);
        break;
      case 'course-progress':
        setPlatformProg(m => ({
          ...m,
          [e.courseId]: { completed: e.completed, total: e.total },
        }));
        break;
      case 'video':
        setVideo({ chapter: e.chapter, ct: e.ct, d: e.d, paused: e.paused });
        break;
      case 'chapter':
        setChapter({ index: e.index, total: e.total, name: e.name, result: e.result });
        break;
      case 'task-done':
        setSummary({ completed: e.completed, skipped: e.skipped });
        break;
      case 'error':
        setLogs(l => [...l.slice(-599), { ts: e.ts, level: 'error', msg: e.message }]);
        break;
    }
  }, []);

  useEffect(() => {
    (async () => {
      const [st, u, inf, prog, gst] = await Promise.all([
        ch().getSettings(),
        ch().getUsername(),
        ch().getAppInfo(),
        ch().getProgress(),
        ch().getState(),
      ]);
      setSettings(st);
      setUsername(u);
      setInfo(inf);
      setStoredProg(prog);
      setEngineState(gst.state);
    })().catch(e => {
      setLogs([{ ts: Date.now(), level: 'error', msg: String(e) }]);
    });
    return ch().onEngineEvent(onEvent);
  }, [onEvent]);

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await ch().setSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const saveCredentials = useCallback(async (u: string, p: string) => {
    await ch().setCredentials(u, p);
    setUsername(u);
  }, []);

  const clearCredentials = useCallback(async () => {
    await ch().clearCredentials();
    setUsername(null);
  }, []);

  const start = useCallback(async () => {
    await ch().start(selected, resume);
  }, [selected, resume]);

  const value: AppCtxType = {
    info,
    settings,
    saveSettings,
    username,
    saveCredentials,
    clearCredentials,
    courses,
    loadingCourses,
    refreshCourses,
    selected,
    setSelected,
    resume,
    setResume,
    engineState,
    detail,
    video,
    chapter,
    platformProg,
    storedProg,
    logs,
    clearLogs: () => setLogs([]),
    summary,
    start,
    pause: () => {
      window.ch.pause();
      setEngineState('paused');
    },
    resumeRun: () => {
      window.ch.resume();
      setEngineState('running');
    },
    stop: () => window.ch.stop(),
    page,
    setPage,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}