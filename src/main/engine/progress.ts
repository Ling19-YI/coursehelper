import * as fs from 'fs';
import * as path from 'path';
import type { CourseProgress } from '../../shared/types';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class ProgressStore {
  constructor(private dataDir: string) {}

  private pathOf(courseId: string) {
    ensureDir(this.dataDir);
    return path.join(this.dataDir, `${courseId}.json`);
  }

  /**
   * 读取指定账号在该课程上的进度。
   *
   * 进度文件只按 courseId 命名，而同一门课可能被多个账号选修。
   * 所以这里必须核对账号，否则换账号后会拿别人的完成记录跳过章节，
   * 表现为「换了账号一个任务点都不刷」。
   *
   * 老数据没有 account 字段 → 认不出归属就当它属于当前账号（沿用），
   * 不做破坏性迁移：宁可多跑一遍，也不要把用户已有的进度丢掉。
   */
  load(courseId: string, account?: string): CourseProgress | null {
    const p = this.pathOf(courseId);
    if (!fs.existsSync(p)) return null;
    try {
      const prog = JSON.parse(fs.readFileSync(p, 'utf-8')) as CourseProgress;
      const owner = prog.account ? String(prog.account).trim() : '';
      const who = account ? String(account).trim() : '';
      if (owner && who && owner !== who) return null;
      return prog;
    } catch {
      return null;
    }
  }

  save(progress: CourseProgress) {
    progress.updatedAt = Date.now();
    fs.writeFileSync(this.pathOf(progress.courseId), JSON.stringify(progress, null, 2), 'utf-8');
  }

  markChapterDone(progress: CourseProgress, onclick: string) {
    if (!progress.completedChapters.includes(onclick)) progress.completedChapters.push(onclick);
    progress.lastChapter = onclick;
    this.save(progress);
  }

  listAll(): CourseProgress[] {
    ensureDir(this.dataDir);
    try {
      return fs
        .readdirSync(this.dataDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf-8'));
          } catch {
            return null;
          }
        })
        .filter(Boolean) as CourseProgress[];
    } catch {
      return [];
    }
  }
}
