import type { Page } from 'playwright';
import * as path from 'path';
import type {
  Course,
  CourseProgress,
  Credentials,
  EngineEvent,
  LogLevel,
  RunOptions,
  RunSummary,
  TaskState,
} from '../../shared/types';
import { TaskControl, StopError } from './control';
import { ProgressStore } from './progress';
import { diagVideo, setMediaPlayback } from './keepalive';
import { login, getCourses, openCourseChapters, clickChapter, goBackToCourse, getChapters } from './chaoxing';
import { handleDocument } from './document';
import { isQuizPage, handleQuiz } from './quiz';
import { waitForVideo, waitForVideoEnd } from './video';
import type { ChapterResult } from '../../shared/types';
import type { EngineHooks } from './hooks';

export interface EngineOptions {
  page: Page;
  dataDir: string;
  emit(e: EngineEvent): void;
  getDeepseekKey(): string;
  /** 视频倍速（1 / 1.25 / 1.5 / 2） */
  getVideoSpeed(): number;
  /** AI 答题总开关 */
  getAgentEnabled(): boolean;
  /** 多模态视觉服务配置 */
  getVision(): { baseUrl: string; apiKey: string; model: string };
}

const clean = (s: string) => s.replace(/\n/g, ' ').trim();

export class ChaoxingEngine {
  readonly ctl = new TaskControl();
  private state: TaskState = 'idle';
  private running = false;
  private loggedIn = false;
  private currentChapter = '';
  private store: ProgressStore;
  private hooks: EngineHooks;

  constructor(private opts: EngineOptions) {
    this.store = new ProgressStore(opts.dataDir);
    this.ctl.onPausedChange = p => {
      if (p) {
        this.setState('paused');
        setMediaPlayback(opts.page, false).catch(() => {});
      } else if (this.state === 'paused') {
        this.setState('running');
        setMediaPlayback(opts.page, true).catch(() => {});
      }
    };
    this.hooks = {
      ctl: this.ctl,
      log: (lvl, msg) => this.log(lvl, msg),
      onTick: s =>
        this.emit({ type: 'video', ...s, chapter: this.currentChapter, ts: Date.now() }),
      diag: tag => diagVideo(opts.page, tag, path.join(opts.dataDir, 'diag')),
      speed: () => {
        const r = Number(opts.getVideoSpeed());
        return isNaN(r) ? 1 : Math.min(2, Math.max(1, r));
      },
      agentEnabled: () => !!opts.getAgentEnabled(),
      vision: () => opts.getVision(),
    };
  }

  get currentState() {
    return this.state;
  }

  get isRunning() {
    return this.running;
  }

  private emit(e: EngineEvent) {
    this.opts.emit(e);
  }

  private log(level: LogLevel, msg: string) {
    this.emit({ type: 'log', level, msg, ts: Date.now() });
  }

  private setState(state: TaskState, detail?: string) {
    this.state = state;
    this.emit({ type: 'state', state, detail, ts: Date.now() });
  }

  pause() {
    this.ctl.pause();
  }

  resume() {
    this.ctl.resume();
  }

  stop() {
    this.ctl.stop();
  }

  getStoredProgress(): CourseProgress[] {
    return this.store.listAll();
  }

  async ensureLogin(creds: Credentials): Promise<boolean> {
    if (this.loggedIn) return true;
    this.setState('login');
    const ok = await login(this.opts.page, this.hooks, creds.username, creds.password);
    if (ok) this.loggedIn = true;
    else this.setState('error', '登录失败');
    return ok;
  }

  async listCourses(creds: Credentials): Promise<Course[]> {
    if (!(await this.ensureLogin(creds))) return [];
    this.setState('listing');
    try {
      const courses = await getCourses(this.opts.page, this.hooks);
      this.emit({ type: 'courses', courses, ts: Date.now() });
      this.setState('idle');
      return courses;
    } catch (e: any) {
      this.setState('error', e?.message);
      this.emit({ type: 'error', message: String(e?.message || e), ts: Date.now() });
      return [];
    }
  }

  async run(courses: Course[], creds: Credentials, options: RunOptions): Promise<RunSummary> {
    const summary: RunSummary = { completed: 0, skipped: 0 };
    if (this.running) {
      this.log('warn', '已有任务在运行');
      return summary;
    }
    this.running = true;
    this.ctl.reset();

    try {
      if (!(await this.ensureLogin(creds))) return summary;
      this.setState('running');

      for (const course of courses) {
        this.ctl.throwIfStopped();
        this.log('info', `\n════ ${course.name} ════`);

        const { chapters, platform } = await openCourseChapters(this.opts.page, this.hooks, course);
        if (!chapters.length) {
          this.log('warn', '✗ 未找到章节，跳过该课程');
          continue;
        }

        const todoable = chapters.filter(c => c.onclick.includes('toOld'));
        let progress = this.store.load(course.courseId);

        // 平台侧任务点已全部完成：用平台口径补齐本地进度，跳过整门课
        if (platform && platform.total > 0 && platform.done >= platform.total) {
          if (!progress) {
            progress = {
              courseId: course.courseId,
              courseName: course.name,
              completedChapters: [],
              lastChapter: '',
              updatedAt: Date.now(),
            };
          }
          for (const c of todoable) {
            if (!progress.completedChapters.includes(c.onclick)) progress.completedChapters.push(c.onclick);
          }
          progress.lastChapter = todoable.length ? todoable[todoable.length - 1].onclick : '';
          this.store.save(progress);
          this.emit({
            type: 'course-progress',
            courseId: course.courseId,
            courseName: course.name,
            completed: todoable.length,
            total: todoable.length,
            lastChapter: progress.lastChapter,
            ts: Date.now(),
          });
          this.log('ok', `✓ 平台显示任务点已全部完成（${platform.done}/${platform.total}），跳过该课程`);
          continue;
        }

        if (progress) {
          this.log('info', `✓ 已保存进度: ${progress.completedChapters.length} 个已完成`);
        }

        const doneHere = () =>
          todoable.filter(c => progress?.completedChapters.includes(c.onclick)).length;

        const ensureProgress = (): CourseProgress => {
          if (!progress) {
            progress = {
              courseId: course.courseId,
              courseName: course.name,
              completedChapters: [],
              lastChapter: '',
              updatedAt: Date.now(),
            };
          }
          return progress as CourseProgress;
        };

        // 平台侧完成标记（用户此前手动刷过的章节）→ 合并进本地进度
        // 平台任务点只在整门课维度给出 X/Y，章节维度只能靠 icon_yiwanc 标记
        const platformDone = todoable.filter(c => c.isCompleted);
        if (platformDone.length) {
          const p = ensureProgress();
          let added = 0;
          for (const c of platformDone) {
            if (!p.completedChapters.includes(c.onclick)) {
              p.completedChapters.push(c.onclick);
              added++;
            }
          }
          if (added) {
            p.lastChapter = platformDone[platformDone.length - 1].onclick;
            this.store.save(p);
          }
          this.log(
            'ok',
            `✓ 平台标记已完成 ${platformDone.length} 个章节（含手动刷过）${added ? `，新增记录 ${added} 个` : ''}`
          );
        }

        let startIdx = 0;
        if (options.resume) {
          let firstUn = -1;
          for (let i = 0; i < chapters.length; i++) {
            const c = chapters[i];
            if (!c.onclick.includes('toOld')) continue;
            if (progress?.completedChapters.includes(c.onclick)) continue;
            firstUn = i;
            break;
          }
          startIdx = firstUn >= 0 ? firstUn : chapters.length;
          this.log(
            'info',
            startIdx < chapters.length
              ? `→ 从第 ${startIdx + 1} 节开始（断点续跑；已跳过 ${doneHere()} 个完成章节）`
              : '→ 已完成章节已全部处理，做收尾检查'
          );
        } else {
          this.log('info', '→ 从第 1 节开始（全部重刷）');
        }

        const emitProgress = () =>
          this.emit({
            type: 'course-progress',
            courseId: course.courseId,
            courseName: course.name,
            completed: doneHere(),
            total: todoable.length,
            lastChapter: progress?.lastChapter,
            ts: Date.now(),
          });
        emitProgress();

        let processed = 0;
        for (let i = startIdx; i < chapters.length; i++) {
          this.ctl.throwIfStopped();
          const chapter = chapters[i];
          if (!chapter.onclick || !chapter.onclick.includes('toOld')) continue;
          if (options.resume && progress?.completedChapters.includes(chapter.onclick)) {
            summary.skipped++;
            this.emit({
              type: 'chapter',
              index: ++processed,
              total: todoable.length,
              name: clean(chapter.name),
              result: 'skipped',
              ts: Date.now(),
            });
            continue;
          }

          const name = clean(chapter.name);
          this.currentChapter = name;
          this.log('info', `\n[${doneHere() + 1}/${todoable.length}] ${name.substring(0, 50)}`);

          let result: ChapterResult = 'error';
          try {
            await clickChapter(this.opts.page, this.hooks, chapter);

            const isQuiz = await isQuizPage(this.opts.page);
            if (isQuiz) {
              const qr = await handleQuiz(this.opts.page, this.hooks, this.opts.getDeepseekKey());
              if (qr.success) {
                this.store.markChapterDone(ensureProgress(), chapter.onclick);
                summary.completed++;
                result = 'quiz_ok';
                this.log('ok', `    ✓ 答题完成 (${qr.answered} 题)`);
              } else {
                summary.skipped++;
                result = 'quiz_skip';
                this.log('warn', '    ⚠ 答题未完成，跳过');
              }
              await goBackToCourse(this.opts.page, this.hooks);
            } else {
              const hasVideo = await waitForVideo(this.opts.page, this.hooks);
              if (!hasVideo) {
                // 文档/文本任务点：渐进滚动到底，再用平台"已完成"标记校验
                const doc = await handleDocument(this.opts.page, this.hooks);
                await goBackToCourse(this.opts.page, this.hooks);
                if (doc === 'scrolled') {
                  const list = await getChapters(this.opts.page);
                  const found = list.find(c => c.onclick === chapter.onclick);
                  if (found?.isCompleted) {
                    this.store.markChapterDone(ensureProgress(), chapter.onclick);
                    summary.completed++;
                    result = 'doc_done';
                    this.log('ok', '    ✓ 文档任务点完成（平台已确认）');
                  } else {
                    summary.skipped++;
                    result = 'no_video';
                    this.log('warn', '    ⚠ 文档已浏览但平台未标记完成，下次重试');
                  }
                } else {
                  summary.skipped++;
                  result = 'no_video';
                  this.log('info', '    - 无视频/无文档，跳过');
                }
              } else {
                const r = await waitForVideoEnd(
                  this.opts.page,
                  this.hooks,
                  this.opts.getDeepseekKey()
                );
                if (r === 'completed') {
                  this.store.markChapterDone(ensureProgress(), chapter.onclick);
                  summary.completed++;
                  result = 'completed';
                } else {
                  summary.skipped++;
                  result = r;
                  this.log('warn', `    ⚠ 跳过（${r}）`);
                }
                await goBackToCourse(this.opts.page, this.hooks);
              }
            }
          } catch (e) {
            if (this.ctl.isStopped) throw e;
            const msg = String((e as any)?.message || e);
            this.log('error', msg);
            this.emit({ type: 'error', message: msg, ts: Date.now() });
            result = 'error';
          }

          this.emit({
            type: 'chapter',
            index: ++processed,
            total: todoable.length,
            name,
            result,
            ts: Date.now(),
          });
          emitProgress();
        }
        emitProgress();
      }

      this.setState('done');
      this.emit({ type: 'task-done', ...summary, ts: Date.now() });
      this.log(
        'ok',
        `🎉 任务完成！已完成 ${summary.completed} 个 / 跳过 ${summary.skipped} 个`
      );
    } catch (e) {
      if (e instanceof StopError || this.ctl.isStopped) {
        this.setState('stopped');
        this.log('warn', '■ 任务已停止');
        this.emit({ type: 'task-done', ...summary, ts: Date.now() });
      } else {
        const msg = String((e as any)?.message || e);
        this.setState('error', msg);
        this.emit({ type: 'error', message: msg, ts: Date.now() });
        this.log('error', `✗ 出错: ${msg}`);
      }
    } finally {
      this.running = false;
      this.currentChapter = '';
    }
    return summary;
  }
}
