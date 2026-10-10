import * as fs from 'fs';
import * as path from 'path';

/**
 * AI 答案本地沉淀（「题库」）。
 *
 * 动机：同一门课、同一章节的题会在不同课程、不同学期反复出现。第一次问 AI
 * 之后把答案存下来，之后同题直接命中，不再调用接口 —— 省时间也省钱，而且
 * 行为上更像一个「用过很多遍题库的人」而不是每次都去问一遍。
 *
 * 存储选 JSON 而非 SQLite：本仓库其它落盘状态（ProgressStore / resume）都是
 * JSON，且几千条量级下 Map + 整体覆写完全够用，不值得为它引一个新依赖。
 * 写入走「临时文件 + rename」原子替换，进程被强杀不会留下半个文件。
 */

export interface TikuEntry {
  stem: string;
  answer: string;
  updated: number;
}

type TikuDb = Record<string, TikuEntry>;

/**
 * 题干归一化 —— 跨课程命中率全靠它。
 *
 * 同一道题在不同卷子里会带不同的题号（"1." vs "12、"）和分值（"(2分)" vs
 * "（5 分）"），不剥掉就永远命中不了缓存，退化成每题都问 AI。
 */
export function normalizeStem(text: string): string {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    // 题号前缀：1. / 12、/ 3) / （4）
    .replace(/^\s*[\uff08(]?\s*\d{1,3}\s*[\.\u3001\uff0e,)）:\uff1a]\s*/, '')
    // 分值：(2分) / 【5 分】 / 10.0分
    .replace(/[\(\uff08【\[]?\s*\d+(?:\.\d+)?\s*分\s*[\)\uff09】\]]?/g, '')
    // 题干里残留的标点与空白
    .replace(/[,。.!?;:()\[\]\-_\/\\|]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export class TikuStore {
  private cache: TikuDb | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string) {}

  private load(): TikuDb {
    if (this.cache) return this.cache;
    let db: TikuDb;
    try {
      db =
        this.file && fs.existsSync(this.file)
          ? JSON.parse(fs.readFileSync(this.file, 'utf-8'))
          : {};
    } catch {
      // 文件损坏时宁可从空库开始，也不要让答题主流程崩在这里
      console.warn('[tiku] 题库文件损坏，重建:', this.file);
      db = {};
    }
    if (!db || typeof db !== 'object' || Array.isArray(db)) db = {};
    this.cache = db;
    return db;
  }

  get(stem: string): string | null {
    const k = normalizeStem(stem);
    if (!k) return null;
    const hit = this.load()[k];
    return hit?.answer || null;
  }

  put(stem: string, answer: string): void {
    const k = normalizeStem(stem);
    const v = String(answer || '').trim();
    if (!k || !v) return;
    const db = this.load();
    db[k] = { stem: String(stem).slice(0, 500), answer: v, updated: Date.now() };
    this.dirty = true;
    this.scheduleFlush();
  }

  size(): number {
    return Object.keys(this.load()).length;
  }

  /** 答题结束/进程退出时调用，确保落盘 */
  flush(): void {
    if (!this.dirty || !this.cache) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), 'utf-8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.warn('[tiku] 写入失败:', e);
    }
  }

  /** 合并写入：一次答题可能拿到十几条答案，攒一起写 */
  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    // 不要因为挂了一个定时器就让主进程一直不退出
    this.timer.unref?.();
  }
}
