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
  chapterIdOf,
  readCurrentChapterId,
  type Chapter,
} from './chaoxing';
import { handleDocument } from './document';
import { isQuizPage, handleQuiz, type AnswerChannel } from './quiz';
import { activeJob, jobKindLabel } from './jobpoint';
import { TikuStore } from './tiku';
import {
  waitForVideo,
  waitForVideoEnd,
  readUnfinishedCount,
  waitUnfinishDrop,
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
  /** 视频倍速（1 / 1.25 / 1.5 / 2） */
  getVideoSpeed(): number;
    /** 视频静音（默认 true） */
    getMuted(): boolean;
  /** AI 答题总开关 */
  getAgentEnabled(): boolean;
  /** 多模态 AI 服务配置——答题、看图解题、随堂弹题共用这一条通道 */
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

  // ── 用户手动切章节的跟随 ──
  /** 本章的目录条目 onclick——拿它的 chapterId 和页面上实际打开的比 */
  private expectedChapterOnclick = '';
  /** 用户手动切到的章节下标（-1 = 没切过）；长循环只读这个内存标记 */
  private manualJumpIndex = -1;
  /** 用户手动打开的那一节已经在屏幕上，别再点目录把他拽回来 */
  private preopenedOnclick = '';
  /** 盯章节切换的定时器 */
  private navTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前课程的章节列表，供定时器把 chapterId 映射回下标 */
  private chapterList: Chapter[] = [];

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
      visionChannel: () => this.visionChannel(),
      tiku: () => this.tiku,
      submitCoverRate: () => opts.getSubmitCoverRate(),
      chapterLeft: () => this.manualJumpIndex >= 0,
    };
  }

  /**
   * AI 通道——全场景就这一条：文本答题、截图识判、随堂弹题都用它。
   *
   * 多模态模型本身就能读文本（/chat/completions 不带图片参数即可），
   * 没必要为纯文本答题再养第二条密钥。双通道时代（多模态 + 旧版
   * DeepSeek 回退）正是「本地可以、用户无解」的根源：两条路径配置
   * 真相不一致，其中一条还没有界面能维护，失效时完全静默。
   *
   * baseUrl 和 apiKey 必须都有：只填 key 不填地址时，会拿着空 baseUrl
   * 去 fetch('/chat/completions')，报一句看不出因果的网络错误。
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

  // ─────────── 用户手动切章节的跟随 ───────────

  /**
   * 盯住「用户是不是把页面切到了别的章节」。
   *
   * 为什么不放在自己的循环里查：刷一门课大部分时间都耗在等视频上（一个视频
   * 几十分钟），而循环里能插检查点的地方只有每轮开头。用户中途点一下侧栏目录
   * 就切走了，等这一轮结束才发现的话，期间 probeVideo 会把新章节的视频当成本
   * 章的继续播，播完还被记到本章头上——完成数虚增，真正做完的那节反而没记。
   * 所以开一个独立的低频轮询（3s，纯读地址栏），命中一次就置内存标记，
   * 各条流程（含长循环）只读这个标记，开销可忽略。
   *
   * 静默失败在这里特别危险：判错的代价是把用户正看着的章节拽走，所以
   * 只在「地址栏里的章节 id 和本章对得上/对不上」这一件事上做判断，读不到
   * 就当没发生。用户若想确认识别是否生效，看日志里那行
   * 「↩ 页面已切到「…」」即可。
   */
  private startChapterWatch(chapters: Chapter[]): void {
    this.stopChapterWatch();
    this.chapterList = chapters;
    this.expectedChapterOnclick = '';
    this.manualJumpIndex = -1;
    this.preopenedOnclick = '';
    this.navTimer = setInterval(() => void this.pollChapterWatch(), 3000);
    // 别让这个定时器拖住进程退出
    this.navTimer.unref?.();
  }

  private stopChapterWatch(): void {
    if (this.navTimer) {
      clearInterval(this.navTimer);
      this.navTimer = null;
    }
  }

  /**
   * 定时探测一次。只读地址栏，`page.url()` 是同步的——不开请求、不与页面
   * 交互，所以没有「读的过程中引擎自己换了章节」的竞态，也不需要互斥。
   */
  private pollChapterWatch(): void {
    // 已经记下结果了就别重复判（后面的流程只读这个标记）
    if (this.manualJumpIndex >= 0) return;
    const expect = this.expectedChapterOnclick;
    // 不在某一章里（课程主页 / 两章之间导航）→ 没有「切走了」可言
    if (!expect) return;

    const seen = readCurrentChapterId(this.opts.page);
    if (!seen) return;

    const here = chapterIdOf(expect);
    // 连「本章的 id」都取不到（目录条目不是 toOld 格式）→ 没有可比的基准，
    // 宁可不判。判错的代价是把用户正在看的章节拽走。
    if (!here) return;
    if (here === seen) return;

    const idx = this.chapterList.findIndex(c => chapterIdOf(c.onclick) === seen);
    // 对不上任何一节（换了门课 / 平台用了别的 id 形式）→ 不下结论
    if (idx < 0) return;

    this.manualJumpIndex = idx;
    this.log(
      'info',
      `\n↩ 页面已切到「${clean(this.chapterList[idx].name)}」——本节让位，从这一节重新开始`,
    );
  }

  /** 停表并清掉跟随状态（换课程 / 收尾时调） */
  private resetChapterWatch(): void {
    this.stopChapterWatch();
    this.expectedChapterOnclick = '';
    this.manualJumpIndex = -1;
    this.preopenedOnclick = '';
    this.chapterList = [];
  }

  /**
   * 让位给用户手动点开的那一节：回目录 / 保留他那一页，并交出下一轮要处理的下标。
   * 没发生手动切换时返回 null。
   *
   * 「他那一页还开着吗」必须用地址栏核对，不能只信我们自己的标记：从发现
   * 切走到他这一节被处理，中间可能夹着**我们自己的导航**（上一节收尾的
   * 「返回课程」、正在点的下一节目录）。那时标记说「已打开」，页面其实已经是
   * 课程主页或别的章节——照着标记跳过点击，就会在新页面上按旧章节记账。
   */
  private async takeManualJump(
    chapters: Chapter[],
    resume: boolean,
    progress: CourseProgress | null,
  ): Promise<number | null> {
    if (this.manualJumpIndex < 0) return null;
    const to = this.manualJumpIndex;
    this.manualJumpIndex = -1;
    const target = chapters[to];
    if (!target) return null;

    const label = clean(target.name);
    const wantId = chapterIdOf(target.onclick);
    // 本地已记完成的那一节，下一轮本来就会跳过——那时手上必须先有目录，
    // 否则「跳过」之后每一节都进不去（见外层 clickChapter）。
    const willSkip = resume && !!progress?.completedChapters.includes(target.onclick);
    const stillOpen =
      !!wantId && !willSkip && readCurrentChapterId(this.opts.page) === wantId;

    if (stillOpen) {
      this.preopenedOnclick = target.onclick;
      this.log('info', `    → 就从你打开的「${label}」继续（不再点目录）`);
    } else {
      this.preopenedOnclick = '';
      this.log(
        'info',
        willSkip
          ? `    → 「${label}」本地已记完成，跳过它，从下一节继续`
          : `    → 回到目录，改从「${label}」开始`,
      );
      await goBackToCourse(this.opts.page, this.hooks);
    }
    return to;
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
      // AI 通道「静默失能」过：多模态明明配好，日志却一直报「未配置」
      // （调用参数漏传，没有编译错误）。开跑先亮一次，省得对着一段
      // 看不出所以然的日志猜——前几次排查都卡在这里。
      //
      // 现在只有一条通道（文本答题/看图解题/随堂弹题共用），所以只有
      // 一个真相。「未配置」必须说清缺哪一半：密钥和地址是两个独立
      // 输入框，只填一个是最高发的误配。
      const ch = this.visionChannel();
      const v = this.opts.getVision();
      const missing: string[] = [];
      if (!v.apiKey) missing.push('API Key');
      if (!v.baseUrl) missing.push('接口地址');
      this.log(
        'info',
        ch
          ? `AI 通道自检：就绪（${ch.model}，答题与看图解题共用）`
          : `AI 通道自检：未配置（缺 ${missing.join(' 和 ')}）——` +
              '文本答题与图片题都会留空，请到设置填写'
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

        // 盯着「用户中途手动切章节」，命中就让位（详见 startChapterWatch）
        this.startChapterWatch(chapters);

        for (let i = startIdx; i < chapters.length; i++) {
          this.ctl.throwIfStopped();
          // 当日视频任务点上限是「今天都不能记」，继续遍历剩下的章节纯属空转：
          // 每个章节都会走一遍「检测到上限→跳过」，日志刷屏还白等一晚上。
          if (dailyLimitHit) break;

          // 上一节收尾期间（回目录、翻页）用户可能已经切走了：先让位，再决定点哪一节。
          // 放在这里而不是只放在内层循环后面，是因为「返回课程」要花几秒，
          // 那几秒里用户点了别的章节的话，直接去点下一节就把他拽回去了。
          const jumpedHere = await this.takeManualJump(chapters, !!options.resume, progress);
          if (jumpedHere !== null) {
            i = jumpedHere - 1; // 配合 for 的 i++，下一轮正好落在他点的那一节
            continue;
          }

          // 换章节前先把跟随目标清空：接下来要么点目录、要么回课程页，
          // 这期间的地址变化是「我们在导航」，不是「用户切走了」。
          this.expectedChapterOnclick = '';
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
          //
          // 例外：这一节正是用户手动切过来的那一节——页面已经打开了，别再点目录。
          // 再点一次会把他从「正在看的那一节」拉回目录再跳一次，观感上就是
          // 「我点的它没听，还把我弹回去」。这个「已经打开」要用地址栏核实，
          // 不能只信标记（takeManualJump 里有同样的理由）。
          const claimedOpen = this.preopenedOnclick === chapter.onclick;
          this.preopenedOnclick = '';
          const enterId = chapterIdOf(chapter.onclick);
          let alreadyOpen = claimedOpen && !!enterId && readCurrentChapterId(this.opts.page) === enterId;
          if (claimedOpen && !alreadyOpen) {
            // 说好保留他那页，页面却已经不在那一节上了——先把目录找回来
            this.log('warn', '    ⚠ 页面上已经不在那一节了，回目录重新进入');
            await goBackToCourse(this.opts.page, this.hooks);
          }
          let entered = alreadyOpen;
          if (alreadyOpen) {
            this.log('info', '    → 已在你手动打开的这一节，直接继续');
          } else {
            entered = await clickChapter(this.opts.page, this.hooks, chapter);
          }
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
          // 页面已经在本章了——从现在起「地址栏里的章节 id」必须和它一致，
          // 不一致就是用户手动切走了（或平台自己跳到了别的章节）。
          this.expectedChapterOnclick = chapter.onclick;

          /**
           * 记账前的最后一道闸。
           *
           * 用户可能在答题 / 看视频 / 看文档的过程中切走，而这几条分支紧接着
           * 就会把这个「完成」记到本章头上。记错的后果不是数字难看，而是本章
           * 在续跑时被永久跳过——没做完的题再也不会被答。
           */
          const markDone = (): boolean => {
            if (this.manualJumpIndex >= 0) return false;
            this.store.markChapterDone(ensureProgress(), chapter.onclick);
            return true;
          };

          for (;;) {
            if (++rounds > MAX_ROUNDS) {
              this.log('warn', `    ⚠ 本章已处理 ${MAX_ROUNDS} 轮仍未完成，放弃`);
              summary.skipped++;
              break;
            }
            // 用户手动切走（定时器已记下目标）：本节到此为止。
            // 不记账、也不 emit——本轮什么都没做完，章节卡片留给重新处理后那一轮。
            if (this.manualJumpIndex >= 0) break;
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
              //
              // 「本章该做哪一种任务点」必须按**当前活跃任务点**判，不能只问
              // 「DOM 里有没有测验 iframe」。一个章节可以并列挂 视频+测验+文档，
              // 三个 iframe 一进页面就同时在 DOM 里——旧逻辑一见测验 iframe 就
              // 整章走答题分支，视频/文档永远轮不到。这正是用户反馈的
              // 「一个章节多个类型……无法识别执行」。详见 jobpoint.ts。
              //
              // 刚进章节那一轮还要先等任务点 iframe 的 URL 落定：iframe 是先
              // 创建后导航，提交顺序不保证与 DOM 次序一致，可能只看得见先提交的
              // 测验 iframe 而把整章误判成测验（同一 bug 换了触发时机）。
              // 用目录声明的任务点总数当收敛判据。
              const wantJobs = rounds === 1 ? chapter.jobCount || 0 : 0;
              const active = await activeJob(this.opts.page, wantJobs);
              if (rounds === 1) {
                if (active.total > 1) {
                  this.log(
                    'info',
                    `    本章共 ${active.total} 个任务点（已完成 ${active.finished}），当前是${
                      active.job ? jobKindLabel(active.kind) : '未能判定的类型'
                    }`
                  );
                }
                // 识别数少于目录声明的任务点数 = 有暂不支持的模块类型，
                // 如实说出来，别让它变成「无声跳过」。
                if (chapter.jobCount > 0 && active.total < chapter.jobCount) {
                  this.log(
                    'warn',
                    `    ⚠ 目录显示本章有 ${chapter.jobCount} 个任务点，只识别到 ${active.total} 个（可能有暂不支持的模块类型，将尽力完成能识别的）`
                  );
                }
              }
              const isQuiz =
                active.kind === 'quiz' ||
                (active.kind === 'unknown' && (await isQuizPage(this.opts.page)));
              // 设置页的「AI 自动答题」是总开关：关掉就所有题目都不答。
              // 它曾经只被声明、从未被读取——用户关掉后测验照样自动答题，
              // 与设置页「关闭后遇到题目会跳过并记入日志」的说明正好相反。
              if (isQuiz && !this.hooks.agentEnabled()) {
                summary.skipped++;
                result = 'quiz_skip';
                this.log('info', '    - AI 自动答题已关闭，跳过该测验');
              } else if (isQuiz) {
                // 唯一一条 AI 通道：文本答题与截图识判共用同一个多模态配置
                const qr = await handleQuiz(this.opts.page, this.hooks, this.visionChannel(), {
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
                  if (markDone()) summary.completed++;
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
                // 已判定是文档任务点就别再去等视频元数据（白等 8s），
                // 直接按文档走；只有类型未判定时才沿用「先探视频」的老路。
                const hasVideo =
                  active.kind === 'document'
                    ? false
                    : await waitForVideo(this.opts.page, this.hooks, doneVideos);
                if (!hasVideo) {
                  // 文档/文本任务点：滚动+拖拽过一遍，再用平台的未完成计数校验。
                  // 用 readUnfinishedCount 而不是回目录翻条目——同章节多任务点
                  // 在目录里只是一个条目，翻条目的结论不可靠。
                  //
                  // ⚠️ 判定标准是「**这一个**任务点有没有被平台记上」，不是
                  // 「整章是否已清零」。混合章节里文档后面往往还挂着测验，
                  // 整章清零要等到最后一轮才成立；拿它当判据的话，文档明明
                  // 过了也会被报成「平台未标记完成」并计一次跳过（完成数少一，
                  // 用户还会看到一条假告警）。所以先记下开工前的待完成数，
                  // 只要它下降了，就是这一个任务点被记上了。
                  const before = await readUnfinishedCount(this.opts.page);
                  const doc = await handleDocument(this.opts.page, this.hooks);
                  if (doc === 'left') {
                    // 用户切走了本章：什么都没做完，不能记账（下面不 markChapterDone）
                    result = 'user_switched';
                  } else if (doc === 'unsupported') {
                    summary.skipped++;
                    result = 'no_video';
                    this.log('info', '    - 无视频/无文档，跳过');
                  } else {
                    const remaining = await readUnfinishedCount(this.opts.page);
                    const credited =
                      remaining !== null &&
                      (remaining <= 0 || (before !== null && remaining < before));
                    if (credited && markDone()) {
                      summary.completed++;
                      result = 'doc_done';
                      this.log('ok', '    ✓ 文档任务点完成（平台已确认）');
                    } else if (credited) {
                      // 用户切走了：这个下降是新页面的，不是本章做完的
                      result = 'user_switched';
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
                  if (r === 'left') {
                    // 用户切走了本章。本节没播完——绝不能走到下面的
                    // markChapterDone，否则新章节的视频会被记成「本章完成」。
                    result = 'user_switched';
                  } else if (r === 'completed') {
                    const picked = lastPickedVideoSrc();
                    if (picked) doneVideos.add(picked); // 记下来，下一轮别再选它
                    if (markDone()) summary.completed++;
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

            // 本轮里用户切走了章节 → 本章一律记成「你切走了本节」。
            // 否则「跳过/未完成」这种属于本章的结论会盖到用户刚打开的新页面上，
            // 用户看到的就自相矛盾了。
            if (this.manualJumpIndex >= 0 && result !== 'user_switched') {
              result = 'user_switched';
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

            // ── 用户切走了本章 ──
            // 后面那几步（读平台未完成数、scroll2Job）都是作用在**新章节**上的，
            // 做了也是白做，还会把日志搅浑。直接交给外层重新定位章节。
            if (result === 'user_switched') break;

            // ── 本章还有没有剩下的任务点 ──
            // 以平台自己的隐藏计数为准（input.jobUnfinishCount），
            // 比翻目录条目可靠：同章节多任务点在目录里只是一个条目。
            if (this.ctl.isStopped || dailyLimitHit) break;

            let left = await readUnfinishedCount(this.opts.page);
            if (left === null) {
              // 读不到就别自作聪明地循环，回目录由外层推进
              break;
            }
            // 本轮确实完成了一个任务点，但平台的计数还没降下来 —— 它是异步记账的
            // （见 waitUnfinishDrop 的说明：短任务点上「引擎按容差判完」会早于
            // 「平台按九成进度记账」）。立刻把「没变」判成本轮白跑会停掉整章，
            // 剩下的任务点全丢，而本章已被本地记成完成，续跑也不会再碰它。
            // 先给平台几秒追赶时间；只有在「本轮什么都没完成」时，计数不降才
            // 真的是白跑（多半是同一个任务点又被播了一遍）。
            const didSomething =
              result === 'completed' || result === 'doc_done' || result === 'quiz_ok';
            if (didSomething && lastLeft !== null && left >= lastLeft) {
              const dropped = await waitUnfinishDrop(this.opts.page, this.hooks, lastLeft);
              if (dropped !== null) left = dropped;
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

          // ── 用户中途手动切换了章节 ──
          // 从他点开的那一节重新开始：把外层游标挪过去，下一轮就处理它。
          const jumped = await this.takeManualJump(chapters, !!options.resume, progress);
          if (jumped !== null) {
            i = jumped - 1; // 配合 for 的 i++，下一轮正好落在 to
            continue;
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
      // 跟随定时器必须停掉：任务结束/被停止后它还在读页面，
      // 下次跑起来会拿上一轮的章节列表做判断
      this.resetChapterWatch();
      // 任务结束/被强杀前把攒着的答案刷盘，避免最后一轮白攒
      this.tiku.flush();
    }
    return summary;
  }
}
