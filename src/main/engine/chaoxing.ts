import type { Page } from 'playwright';
import type { Course } from '../../shared/types';
import type { EngineHooks } from './hooks';

export const LOGIN_URL = 'https://i.mooc.chaoxing.com/space/index?ws=1&t=1779594450165';
export const COURSE_LIST_URL =
  'https://mooc1-1.chaoxing.com/visit/interaction?s=775da1a566dbca1933653ce05b2b43a3';
/** 官方「我学的课」接口：只返回选课班（学生身份），不含「我教的课」 */
export const MY_COURSE_API = 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&rss=1';

export interface Chapter {
  name: string;
  onclick: string;
  isCompleted: boolean;
}

interface RawCourse {
  name: string;
  url: string;
  courseId: string;
}

/** 组装课程学习页地址（与平台列表页链接格式一致） */
function buildCourseUrl(courseId: string, clazzId: string, cpi: string): string {
  return (
    'https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle' +
    `?courseid=${courseId}&clazzid=${clazzId}&vc=1&cpi=${cpi}&ismooc2=1&v=2`
  );
}

/** 走官方接口取「我学的课」；接口不可用返回 null */
async function fetchEnrolledCourses(
  page: Page
): Promise<{ list: RawCourse[]; hasMore: boolean; roleSkipped: number } | null> {
  const data = await page.evaluate(async (api: string) => {
    try {
      const r = await fetch(api, { credentials: 'include' });
      if (!r.ok) return { err: 'HTTP ' + r.status };
      const j = await r.json();
      if (j?.result !== 1 || !Array.isArray(j.channelList)) return { err: '返回结构异常' };
      return { channelList: j.channelList, hasMore: !!j.hasMore };
    } catch (e) {
      return { err: String(e) };
    }
  }, MY_COURSE_API);

  if ('err' in (data as any)) return null;
  const { channelList, hasMore } = data as { channelList: any[]; hasMore: boolean };

  const list: RawCourse[] = [];
  let roleSkipped = 0;
  for (const item of channelList) {
    const c = item?.content ?? {};
    // roletype: 3=学生；1/2=教师/助教，属于「我教的课」，直接剔除
    const rt = Number(c.roletype);
    if (rt === 1 || rt === 2) {
      roleSkipped++;
      continue;
    }
    const info = c?.course?.data?.[0];
    const courseId = String(info?.id ?? '');
    const name = String(info?.name ?? '').trim();
    if (!courseId || !name) continue;
    const clazzId = String(item.key ?? c.id ?? '');
    const cpi = String(item.cpi ?? c.cpi ?? '');
    list.push({ name, courseId, url: buildCourseUrl(courseId, clazzId, cpi) });
  }
  return { list, hasMore, roleSkipped };
}

/**
 * 强制切到「我学的课」并确认生效。
 * 课表页默认页签由平台会话状态决定（可能落在「我教的课」），必须点一下并等到高亮真的切过去。
 */
async function ensureStudiedTab(page: Page, h: EngineHooks): Promise<void> {
  const readTabs = () =>
    page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.course-tab .tab-item')];
      const cur = tabs.find(t => String(t.className).includes('current'));
      return {
        count: tabs.length,
        labels: tabs.map(t => (t.textContent || '').trim()),
        active: (cur?.textContent || '').trim(),
      };
    });

  const clickStudied = () =>
    page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.course-tab .tab-item')];
      const mine = tabs.find(t => (t.textContent || '').includes('我学'));
      if (mine) (mine as HTMLElement).click();
      return !!mine;
    });

  const info0 = await readTabs();
  if (info0.count === 0) {
    h.log('warn', '   未找到课表页签，按当前列表读取');
    return;
  }
  if (info0.active.includes('我学')) {
    h.log('info', '   当前页签已是我学的课');
    return;
  }

  h.log('warn', `   页签默认落在「${info0.active || '未知'}」，正在切换到「我学的课」`);
  if (!(await clickStudied())) {
    throw new Error(
      `课表页签为「${info0.active || '未知'}」（可选：${info0.labels.join('/')}），` +
        '已跳过读取以免把我教的课当成我学的课'
    );
  }

  // 轮询确认切换生效（平台切页签是异步渲染）
  for (let i = 0; i < 10; i++) {
    await h.ctl.sleep(700);
    const info = await readTabs();
    if (info.active.includes('我学')) {
      h.log('ok', '   ✓ 已切换到「我学的课」');
      return;
    }
    if (i === 4) await clickStudied(); // 没反应就再点一次
  }

  const info = await readTabs();
  throw new Error(
    `课表页签为「${info.active || '未知'}」（可选：${info.labels.join('/')}），` +
      '已跳过读取以免把我教的课当成我学的课'
  );
}

/** DOM 兜底：先确认页签是「我学的课」，再只从该面板取课程 */
async function scrapeStudiedCourses(page: Page, h: EngineHooks): Promise<RawCourse[]> {
  await ensureStudiedTab(page, h);

  await page
    .waitForFunction(() => document.querySelectorAll('ul.course-list li.course, li.course').length > 0, {
      timeout: 15000,
    })
    .catch(() => {});

  const frame = page.frames()[0];
  const raw = await frame.$$eval('ul.course-list li.course, li.course', (els: any[]) => {
    const seen = new Set<string>();
    const out: { name: string; url: string; courseId: string }[] = [];
    for (const el of els) {
      const a = el.querySelector('a[href*="courseid"]') as HTMLAnchorElement | null;
      if (!a) continue;
      const href = a.href || '';
      const courseId = (href.match(/courseid=(\d+)/) || [])[1] || '';
      const name =
        (el.querySelector('h3')?.innerText || '').trim() ||
        (a.innerText || '').trim() ||
        (el.innerText || '').trim().split('\n')[0];
      if (!courseId || !name || seen.has(href)) continue;
      seen.add(href);
      out.push({ name: name.slice(0, 60), url: href, courseId });
    }
    return out;
  });
  return raw;
}

export async function getCourses(page: Page, h: EngineHooks): Promise<Course[]> {
  h.log('info', '[2/4] 获取课程列表（我学的课）...');

  // 先进入课表页：接口与页面解析都在这个域下执行（同源，接口不会被 CORS 拦）
  await page.goto(COURSE_LIST_URL, { timeout: 30000 });
  await h.ctl.sleep(3000);

  let list: RawCourse[] = [];
  let source = '';
  const api = await fetchEnrolledCourses(page);
  if (api && api.list.length) {
    list = api.list;
    source = '官方接口';
    if (api.hasMore) h.log('warn', '   平台提示还有更多课程未返回，列表可能不完整');
    if (api.roleSkipped) h.log('info', `   已跳过 ${api.roleSkipped} 门「我教的课」`);
  } else {
    h.log('info', '   官方接口不可用，改用页面解析');
    list = await scrapeStudiedCourses(page, h);
    source = '页面解析';
  }

  // 兜底：仍为空则刷新页面再解析一次
  if (!list.length) {
    h.log('info', '   列表为空，刷新后重试');
    await page.reload({ timeout: 30000 });
    await h.ctl.sleep(3000);
    list = await scrapeStudiedCourses(page, h);
    source = '页面解析(重试)';
  }

  const result: Course[] = [];
  const seenId = new Set<string>();
  let dup = 0;
  for (const c of list) {
    const key = String(c.courseId);
    if (seenId.has(key)) {
      dup++;
      continue;
    }
    seenId.add(key);
    result.push({ index: result.length + 1, name: c.name, url: c.url, courseId: key });
  }
  if (dup) h.log('info', `   已合并 ${dup} 门重复选课（同一课程多个教学班）`);
  h.log('ok', `✓ 找到 ${result.length} 门课程（我学的课 · 来源：${source}）`);
  return result;
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
