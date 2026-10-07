import type { Page } from 'playwright';
import type { Course } from '../../shared/types';
import type { EngineHooks } from './hooks';

export const LOGIN_URL = 'https://i.mooc.chaoxing.com/space/index?ws=1&t=1779594450165';
export const COURSE_LIST_URL =
  'https://mooc1-1.chaoxing.com/visit/interaction?s=775da1a566dbca1933653ce05b2b43a3';

export interface Chapter {
  name: string;
  onclick: string;
  isCompleted: boolean;
}

export async function login(page: Page, h: EngineHooks, username: string, password: string): Promise<boolean> {
  h.log('info', '[1/4] 登录中...');
  await page.goto(LOGIN_URL, { timeout: 30000 });
  await h.ctl.sleep(3000);
  await page.locator('#phone').fill(username);
  await page.locator('#pwd').fill(password);
  await page.locator('.btn-big-blue').click();
  await h.ctl.sleep(5000);
  if (!page.url().includes('passport2')) {
    h.log('ok', '✓ 登录成功');
    return true;
  }
  h.log('error', '✗ 登录失败（账号密码错误或需要验证码）');
  return false;
}

export async function getCourses(page: Page, h: EngineHooks): Promise<Course[]> {
  h.log('info', '[2/4] 获取课程列表...');
  await page.goto(COURSE_LIST_URL, { timeout: 30000 });
  await h.ctl.sleep(3000);
  const frame = page.frames()[0];
  const courses = await frame.$$eval('a[href*="courseid"]', (els: any[]) => {
    const seen = new Set<string>();
    return els
      .map(el => {
        const name = (el.innerText || '').trim();
        const href = el.href;
        const match = href.match(/courseid=(\d+)/);
        const courseId = match ? match[1] : '';
        if (!name || seen.has(href)) return null;
        seen.add(href);
        return { name, href, courseId };
      })
      .filter(Boolean);
  });
  const result: Course[] = courses.map((c: any, i: number) => ({
    index: i + 1,
    name: c.name,
    url: c.href,
    courseId: c.courseId,
  }));
  h.log('ok', `✓ 找到 ${result.length} 门课程`);
  return result;
}

export async function getChapters(page: Page): Promise<Chapter[]> {
  const frame = page.frames()[1];
  if (!frame) return [];
  return frame.$$eval('[class*="chapter_item"]', (els: any[]) =>
    els.map(el => {
      const html: string = el.outerHTML || '';
      const text: string = el.innerText || '';
      return {
        name: text.trim().substring(0, 60),
        onclick: el.getAttribute('onclick') || '',
        // 平台完成标记：已完成图标 icon_yiwanc / 文本"已完成" / completed 类名
        isCompleted:
          html.includes('icon_yiwanc') ||
          text.includes('已完成') ||
          String(el.className).includes('completed') ||
          String(el.className).includes('finished') ||
          String(el.className).includes('done'),
      };
    })
  );
}

export async function clickChapter(page: Page, h: EngineHooks, chapter: Chapter) {
  const frame = page.frames()[1];
  if (!frame) return;
  const el = await frame.$(`[onclick="${chapter.onclick}"]`);
  if (el) {
    await el.click({ force: true });
    await h.ctl.sleep(3000);
  }
}

export async function goBackToCourse(page: Page, h: EngineHooks) {
  const back = await page.$('text=返回课程');
  if (back) {
    await back.click({ force: true });
    await h.ctl.sleep(2000);
  }
  const tab = await page.$('text=章节');
  if (tab) {
    await tab.click({ force: true });
    await h.ctl.sleep(2000);
  }
}

/** 进入课程并切换到章节页签，返回章节列表与平台侧任务点进度 */
export async function openCourseChapters(
  page: Page,
  h: EngineHooks,
  course: Course
): Promise<{ chapters: Chapter[]; platform: { done: number; total: number } | null }> {
  await page.goto(course.url, { timeout: 30000 });
  await h.ctl.sleep(5000);
  const tab = await page.$('text=章节');
  if (tab) {
    await tab.click({ force: true });
    await h.ctl.sleep(5000);
  }
  const chapters = await getChapters(page);
  h.log('ok', `✓ 找到 ${chapters.length} 个任务点`);

  let platform: { done: number; total: number } | null = null;
  for (const f of page.frames()) {
    try {
      const t: string = await f.$eval('body', b => (b as HTMLElement).innerText);
      const m = t.match(/已完成任务点[:：]\s*(\d+)\s*\/\s*(\d+)/);
      if (m) {
        platform = { done: parseInt(m[1], 10), total: parseInt(m[2], 10) };
        break;
      }
    } catch {}
  }
  if (platform) h.log('info', `   平台进度: ${platform.done}/${platform.total}`);
  return { chapters, platform };
}
