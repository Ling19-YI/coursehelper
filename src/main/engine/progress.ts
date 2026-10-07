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

  load(courseId: string): CourseProgress | null {
    const p = this.pathOf(courseId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
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
