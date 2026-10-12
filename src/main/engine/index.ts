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
import {
  login,
  getCourses,
  openCourseChapters,
  clickChapter,
  goBackToCourse,
  diagnoseEmptyChapters,
} from './chaoxing';
import { handleDocument } from './document';
import { isQuizPage, handleQuiz, type AnswerChannel } from './quiz';
import { TikuStore } from './tiku';
import {
  waitForVideo,
  waitForVideoEnd,
  readUnfinishedCount,
  detectDailyLimit,
  gotoUnfinishedJob,
  lastPickedVideoSrc,
} from './video';
import type { ChapterResult } from '../../shared/types';
import type { EngineHooks } from './hooks';

export interface EngineOptions {
  page: Page;
  dataDir: string;
  emit(e: EngineEvent): void;
  getDeepseekKey(): string;
  /** 视频倍速（1 / 1.25 / 1.5 / 2） */
  getVideoSpeed(): number;
    /** 视频静音（默认 true） */
    getMuted(): boolean;
  /** AI 答题总开关 */
  getAgentEnabled(): boolean;
  /** 多模态视觉服务配置 */
  getVision(): { baseUrl: string; apiKey: string; model: string };
  /** 交卷前要求的最低答案覆盖率（0~1，0=关闭） */
  getSubmitCoverRate(): number;
  /** 是否自动处理视频播放期间的随堂题弹窗 */
  getAnswerPopup(): boolean;
  /** 是否因「验证类」弹窗（人脸/验证码/安全验证）暂停等人工。默认 false */
  getAutoPauseOnVerify(): boolean;
}

const clean = (s: string) => s.replace(/\n/g, ' ').trim();

export class ChaoxingEngine {
  readonly ctl = new TaskControl();
  private state: TaskState = 'idle';
  private running = false;
  private loggedIn = false;
  private currentChapter = '';
  private store: ProgressStore;
  private tiku: TikuStore;
  private hooks: EngineHooks;

  constructor(private opts: EngineOptions) {
    this.store = new ProgressStore(opts.dataDir);
    this.tiku = new TikuStore(path.join(opts.dataDir, 'tiku.json'));
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
      muted: () => opts.getMuted() !== false,
      agentEnabled: () => !!opts.getAgentEnabled(),
      vision: () => opts.getVision(),
      // 受总开关门控：agentEnabled 关掉时随堂弹题也不答。
      // 设置页把它描述为「总开关」，就得真的管住所有答题路径。
      answerPopup: () => !!opts.getAgentEnabled() && !!opts.getAnswerPopup(),
      autoPauseOnVerify: () => !!opts.getAutoPauseOnVerify(),
      visionChannel: () => this.answerChannel(),
      deepseekKey: () => opts.getDeepseekKey(),
      tiku: () => this.tiku,
      submitCoverRate: () => opts.getSubmitCoverRate(),
    };
  }

  /**
   * 章节测验用的 AI 通道。
   *
   * 优先用多模态配置：用户通常只填了「多模态 API Key」，
   * 而多模态接口本身就是 OpenAI 兼容的 /chat/completions，
   * 纯文本答题无需图片参数，可以直接复用。
   * 只有在没配多模态时才回退到单独的 DeepSeek Key。
   */
  private answerChannel(): AnswerChannel | null {
    const v = this.opts.getVision();
    // baseUrl 和 apiKey 都必须有：只填 key 不填地址时，会拿着空 baseUrl 去
    // fetch('/chat/completions')，报一句看不出因果的网络错误。
    if (v?.apiKey && v.baseUrl) {
      return { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, label: '多模态' };
    }
    const dk = this.opts.getDeepseekKey();
    if (dk) {
      return {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: dk,
        model: 'deepseek-chat',
        label: 'DeepSeek',
      };
    }
    return null;
  }

  /**
   * 多模态专用通道，供「截图搜题」用。
   *
   * ⚠️ 不要复用 answerChannel()：那个在没配多模态时会回退到 DeepSeek，
   * 而 DeepSeek 是纯文本模型，收不了图。截图识判必须只认多模态配置，
   * 否则会把图片请求发到不支持图片的接口上，返回一句看不出因果的错。
   */
  private visionChannel(): AnswerChannel | null {
    const v = this.opts.getVision();
    if (v?.apiKey && v.baseUrl) {
      return { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, label: '多模态' };
    }
    return null;
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
    // 平台「今日任务点完成数已达上限」——命中后视频照放但不记完成，
    // 继续跑纯空转。用一个标志让它能中止整轮并在收尾时说明原因。
    let dailyLimitHit = false;

    try {
      if (!(await this.ensureLogin(creds))) return summary;
      this.setState('running');

      // ── 开跑前的能力自检 ──
      // 这两条通道都「静默失能」过：多模态明明配好，日志却一直报
      // 「未配置多模态通道」（调用参数漏传，没有编译错误）；答题通道到底
      // 回退到了谁，也没人确认过。开跑先亮一次，省得对着一段看不出所以然
      // 的日志猜——上两次排查都卡在这里。
      const vch = this.visionChannel();
      const ach = this.answerChannel();
      this.log(
        'info',
        `AI 通道自检：答题=${ach ? `${ach.label}/${ach.model}` : '未配置'}` +
          ` | 多模态=${vch ? `就绪/${vch.model}` : '未配置（图片题会留空）'}`
      );

      for (const course of courses) {
        this.ctl.throwIfStopped();
        this.log('info', `\n════ ${course.name} ════`);

        const { chapters, platform } = await openCourseChapters(this.opts.page, this.hooks, course);
        if (!chapters.length) {
          // 光说「未找到章节」没法定位。按最常见的原因给出可操作提示：
          // 换账号后仍用旧课表 → 用新会话打开旧班级链接 → 无权限页 → 目录为空。
          const reason = await diagnoseEmptyChapters(this.opts.page);
          this.log('warn', `✗ 未找到章节，跳过该课程${reason ? `（${reason}）` : ''}`);
          this.log('info', '   若刚换过账号，请重新获取一次课程列表再开始');
          continue;
        }

        const todoable = chapters.filter(c => c.onclick.includes('toOld'));
        // 进度按 (账号, courseId) 归属。同一门课可能被多个账号选修，
        // 不核对账号就会拿别人的完成记录跳过章节。
        const accountKey = String(creds?.username || '').trim();
        let progress = this.store.load(course.courseId, accountKey);

        // 平台侧任务点已全部完成：用平台口径补齐本地进度，跳过整门课
        if (platform && platform.total > 0 && platform.done >= platform.total) {
          if (!progress) {
            progress = {
              courseId: course.courseId,
              courseName: course.name,
              completedChapters: [],
              lastChapter: '',
              updatedAt: Date.now(),
              account: accountKey,
            };
          }
          progress.account = progress.account || accountKey;
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
              account: accountKey,
            };
          }
          // 老进度文件没有 account 字段，认领为当前账号，避免下次又认不出
          if (!progress.account) progress.account = accountKey;
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
        // 目录失效（平台刷新/收起/风控页）后允许重新打开课程页一次，
        // 否则一旦进入空目录状态，后面每个章节都会「找不到」并全部跳过。
        let reopened = false;

        for (let i = startIdx; i < chapters.length; i++) {
          this.ctl.throwIfStopped();
          // 当日视频任务点上限是「今天都不能记」，继续遍历剩下的章节纯属空转：
          // 每个章节都会走一遍「检测到上限→跳过」，日志刷屏还白等一晚上。
          if (dailyLimitHit) break;
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
          // 一个 chapter_item 可能含多个任务点，日志里带上待完成数才有可读性
          const jobNote = chapter.jobCount > 1 ? `（含 ${chapter.jobCount} 个任务点）` : '';
          this.log(
            'info',
            `\n[${doneHere() + 1}/${todoable.length}] ${name.substring(0, 50)}${jobNote}`
          );

          // ── 一章多任务点 ──
          // 实机确认：同一章节的多个任务点并列挂在同一个页面里（会同时出现
          // 两个 ananas/modules/video iframe），而且目录条目的
          // onclick="toOld(courseId, chapterId, clazzId, 0)" 末位参数恒为 0，
          // 回目录再点只会又打开同一个任务点。所以必须在页面内推进：
          // 播完一个就地找下一个未完成的视频接着播。
          let rounds = 0;
          const MAX_ROUNDS = 12;
          let lastLeft: number | null = null;
          // 本章已经播完的视频 src。时长启发式可能因 duration 偶发读到 0 而失效，
          // 那时 probeVideo 会重新选中刚播完的那个（用户实测：第一个视频反复播、
          // 第二个永远轮不到）。按 src 精确排除，不依赖启发式。
          const doneVideos = new Set<string>();

          // ⚠️ 进章节只做一次，绝不能放进下面的循环。
          // 放进循环的话，每轮都会重新触发 toOld(...,0)——而它的末位参数恒为 0，
          // 等于把页面重置回第一个任务点，第二个视频永远轮不到，还会反复重播
          // 第一个。这正是「一章两个视频不会自动往下」的原因。
          let entered = await clickChapter(this.opts.page, this.hooks, chapter);
          if (!entered && !reopened) {
            // 目录里找不到多半是页面已失效（实测会出现「返回课程后目录为空」，
            // 之后每个章节都找不到）。重新打开课程页恢复一次，别直接放弃——
            // 放弃了就是后面整片章节全部跳过。
            reopened = true;
            this.log('warn', '    ⚠ 目录不可用，重新打开课程页后重试');
            try {
              await openCourseChapters(this.opts.page, this.hooks, course);
              entered = await clickChapter(this.opts.page, this.hooks, chapter);
            } catch (e) {
              this.log('warn', `    ⚠ 重新打开课程页失败：${String((e as any)?.message || e)}`);
            }
          }
          if (!entered) {
            summary.skipped++;
            this.log('warn', '    ⚠ 未能进入该章节，跳过');
            this.emit({
              type: 'chapter',
              index: ++processed,
              total: todoable.length,
              name,
              result: 'enter_failed',
              ts: Date.now(),
            });
            emitProgress();
            continue;
          }

          for (;;) {
            if (++rounds > MAX_ROUNDS) {
              this.log('warn', `    ⚠ 本章已处理 ${MAX_ROUNDS} 轮仍未完成，放弃`);
              summary.skipped++;
              break;
            }
            // 平台自报「今日任务点完成数已达上限」时，视频照放但不记完成，
            // 继续刷纯属空转，直接停下并说明，别让用户白等一整晚。
            if (await detectDailyLimit(this.opts.page)) {
              this.log('warn', '    ⚠ 平台提示「今日视频任务点完成数已达上限」');
              this.log('warn', '      视频能正常播放，但平台不会记入完成——先停，明天再刷');
              dailyLimitHit = true;
              break;
            }

            let result: ChapterResult = 'error';
            try {
              // 本轮不再点章节——页面已在本章，靠 scroll2Job 在本页内切换任务点
              const isQuiz = await isQuizPage(this.opts.page);
              // 设置页的「AI 自动答题」是总开关：关掉就所有题目都不答。
              // 它曾经只被声明、从未被读取——用户关掉后测验照样自动答题，
              // 与设置页「关闭后遇到题目会跳过并记入日志」的说明正好相反。
              if (isQuiz && !this.hooks.agentEnabled()) {
                summary.skipped++;
                result = 'quiz_skip';
                this.log('info', '    - AI 自动答题已关闭，跳过该测验');
              } else if (isQuiz) {
                const qr = await handleQuiz(
                  this.opts.page,
                  this.hooks,
                  this.opts.getDeepseekKey(),
                  this.answerChannel(),
                  {
                    tiku: this.tiku,
                    submitCoverRate: this.opts.getSubmitCoverRate(),
                    // 必须显式传：QuizOptions 里早就有这个字段，注释也写明
                    // 「配了就启用截图搜题」，但调用方一直漏传，于是
                    // `opts?.visionChannel?.apiKey` 恒为 undefined ——
                    // 图片题干/超星字体替换的题从来没走过截图识别，
                    // 日志还一直显示「未配置多模态通道」（即使配了）。
                    visionChannel: this.visionChannel(),
                  }
                );
                if (qr.success) {
                  this.store.markChapterDone(ensureProgress(), chapter.onclick);
                  summary.completed++;
                  result = 'quiz_ok';
                  this.log('ok', `    ✓ 答题完成 (${qr.answered} 题)`);
                } else {
                  summary.skipped++;
                  result = 'quiz_skip';
                  this.log(
                    'warn',
                    `    ⚠ 答题未完成，跳过（覆盖 ${Math.round(qr.coverage * 100)}%）`
                  );
                }
              } else {
                const hasVideo = await waitForVideo(this.opts.page, this.hooks, doneVideos);
                if (!hasVideo) {
                  // 文档/文本任务点：滚动+拖拽过一遍，再用平台的未完成计数校验。
                  // 用 readUnfinishedCount 而不是回目录翻条目——同章节多任务点
                  // 在目录里只是一个条目，翻条目的结论不可靠。
                  const doc = await handleDocument(this.opts.page, this.hooks);
                  if (doc === 'unsupported') {
                    summary.skipped++;
                    result = 'no_video';
                    this.log('info', '    - 无视频/无文档，跳过');
                  } else {
                    const remaining = await readUnfinishedCount(this.opts.page);
                    const done = remaining !== null && remaining <= 0;
                    if (done) {
                      this.store.markChapterDone(ensureProgress(), chapter.onclick);
                      summary.completed++;
                      result = 'doc_done';
                      this.log('ok', '    ✓ 文档任务点完成（平台已确认）');
                    } else {
                      summary.skipped++;
                      result = 'no_video';
                      this.log(
                        'warn',
                        `    ⚠ 文档已浏览但平台未标记完成${remaining === null ? '（读不到未完成计数）' : `（还剩 ${remaining} 个）`}`
                      );
                    }
                  }
                } else {
                  const r = await waitForVideoEnd(this.opts.page, this.hooks, doneVideos);
                  if (r === 'completed') {
                    const picked = lastPickedVideoSrc();
                    if (picked) doneVideos.add(picked); // 记下来，下一轮别再选它
                    this.store.markChapterDone(ensureProgress(), chapter.onclick);
                    summary.completed++;
                    result = 'completed';
                  } else {
                    summary.skipped++;
                    result = r;
                    this.log('warn', `    ⚠ 跳过（${r}）`);
                  }

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

            // ── 本章还有没有剩下的任务点 ──
            // 以平台自己的隐藏计数为准（input.jobUnfinishCount），
            // 比翻目录条目可靠：同章节多任务点在目录里只是一个条目。
            if (this.ctl.isStopped || dailyLimitHit) break;

            const left = await readUnfinishedCount(this.opts.page);
            if (left === null) {
              // 读不到就别自作聪明地循环，回目录由外层推进
              break;
            }
            if (left <= 0) {
              if (rounds > 1 || chapter.jobCount > 1) {
                this.log('ok', '    ✓ 本章任务点已全部完成');
              }
              break;
            }
            // 待完成数没下降说明本轮白跑（多半是又把同一个任务点播了一遍）。
            // 立即停手，别闷头重试 12 轮——那样用户只会看到同一段视频循环播放。
            if (lastLeft !== null && left >= lastLeft) {
              this.log('warn', `    ⚠ 本章待完成数仍为 ${left}（未下降），停止本章`);
              break;
            }
            lastLeft = left;

            // 还有未完成的任务点：平台自带的 scroll2Job 会跳到它，
            // 下一轮循环再探测视频。若跳不过去，回目录由外层推进。
            const jumped = await gotoUnfinishedJob(this.opts.page);
            this.log(
              'info',
              `    → 本章还有 ${left} 个任务点未完成${jumped ? '' : '（未能跳转，回目录处理）'}`
            );
            if (!jumped) break;
            await this.hooks.ctl.sleep(1500);
          }

          // 本章处理完（或放弃）后再回目录。放在这里而不是各分支里，
          // 是因为页面内推进期间不能离开本页——一离开就回到「点条目只能
          // 打开同一个任务点」的困境。
          await goBackToCourse(this.opts.page, this.hooks);
        }
        emitProgress();
      }

      this.setState('done');
      this.emit({ type: 'task-done', ...summary, ts: Date.now() });
      this.log(
        'ok',
        `🎉 任务完成！已完成 ${summary.completed} 个 / 跳过 ${summary.skipped} 个`
      );
      if (dailyLimitHit) {
        this.log(
          'warn',
          '⚠ 本轮因平台「今日视频任务点完成数已达上限」提前结束。' +
            '视频本身能正常播放，但平台不记入完成——明天再刷剩下的即可。'
        );
      }
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
      // 任务结束/被强杀前把攒着的答案刷盘，避免最后一轮白攒
      this.tiku.flush();
    }
    return summary;
  }
}
