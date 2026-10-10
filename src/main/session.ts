import { BrowserWindow, WebContentsView } from 'electron';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';

const CDP_URL = 'http://127.0.0.1:9333';

const PLACEHOLDER_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;height:100%;background:#0f172a;color:#64748b;font:14px/1.6 "Microsoft YaHei",sans-serif;}' +
  '.wrap{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;}' +
  'b{color:#94a3b8;font-size:16px;display:block;margin-bottom:8px;}</style></head>' +
  '<body><div class="wrap"><div><b>课程页面区域</b>点击「获取课程」或开始任务后<br>超星学习通页面将在此处打开</div></div></body></html>';
const PLACEHOLDER_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PLACEHOLDER_HTML);

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 课程页会话管理：
 *  优先 = Electron 自带 WebContentsView + connectOverCDP（单窗口、零浏览器下载）
 *  回退 = 独立 Playwright Chromium 窗口（CDP 不可用时）
 */
export class Session {
  private view: WebContentsView | null = null;
  private browser: Browser | null = null;
  private fallback: { browser: Browser; context: BrowserContext } | null = null;
  private page: Page | null = null;
  private rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  mode: 'embedded' | 'fallback' | null = null;

  constructor(private win: BrowserWindow) {}

  setBounds(r: Rect) {
    this.rect = r;
    this.view?.setBounds(r);
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView();
    this.win.contentView.addChildView(view);
    view.setBounds(this.rect);
    view.webContents.loadURL(PLACEHOLDER_URL);
    this.view = view;
    return view;
  }

  private async findEmbeddedPage(view: WebContentsView): Promise<Page | null> {
    if (!this.browser) this.browser = await chromium.connectOverCDP(CDP_URL);
    const deadline = Date.now() + 8000;
    let url = view.webContents.getURL();
    while ((!url || url === 'about:blank') && Date.now() < deadline) {
      await sleep(200);
      url = view.webContents.getURL();
    }
    const pages = this.browser.contexts().flatMap(c => c.pages());
    const target = pages.find(p => p.url() === url);
    if (target) return target;
    // URL 可能已跳转，排除渲染进程 UI 页面后取唯一候选
    const others = pages.filter(p => !isUiPage(p.url()));
    if (others.length === 1) return others[0];
    console.warn('[session] 未定位课程页, candidates=', pages.map(p => p.url()));
    return null;
  }

  private async ensureFallbackPage(): Promise<Page> {
    if (this.fallback) {
      const p = this.page;
      if (p && !p.isClosed()) return p;
    }
    const browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    this.fallback = { browser, context };
    this.mode = 'fallback';
    return page;
  }

  /**
   * 仅清除超星相关 Cookie，不关窗口、不动页面。
   * 换账号时调用：否则平台会沿用旧身份，表现为「填了新账号还是旧账号的课」。
   */
  async clearAuthCookies(): Promise<void> {
    const domains = [
      'https://chaoxing.com',
      'https://www.chaoxing.com',
      'https://mooc1.chaoxing.com',
      'https://mooc1-1.chaoxing.com',
      'https://mooc1-2.chaoxing.com',
      'https://mooc1-3.chaoxing.com',
      'https://mooc2-ans.chaoxing.com',
      'https://i.mooc.chaoxing.com',
      'https://passport2.chaoxing.com',
    ];
    try {
      const page = await this.ensurePage();
      await page.context().clearCookies();
      return;
    } catch {}
    // 内嵌模式拿不到 Page 时，直接对 Electron 会话下手
    try {
      const ses = this.view?.webContents?.session;
      if (!ses) return;
      for (const d of domains) {
        await ses.clearStorageData({ origin: d, storages: ['cookies'] }).catch(() => {});
      }
      await ses.clearStorageData({ storages: ['cookies'] }).catch(() => {});
    } catch (e) {
      console.warn('[session] 清除登录 Cookie 失败:', e);
    }
  }

  async ensurePage(): Promise<Page> {
    if (this.page) {
      try {
        if (!this.page.isClosed()) return this.page;
      } catch {}
      this.page = null;
    }

    if (this.mode !== 'fallback') {
      try {
        const view = this.ensureView();
        const p = await this.findEmbeddedPage(view);
        if (p) {
          this.page = p;
          this.mode = 'embedded';
          return p;
        }
        console.warn('[session] 内嵌模式定位失败，回退到独立浏览器');
      } catch (e) {
        console.warn('[session] 内嵌模式不可用，回退到独立浏览器:', e);
      }
    }

    this.page = await this.ensureFallbackPage();
    return this.page;
  }

  dispose() {
    try {
      if (this.browser) this.browser.close();
    } catch {}
    try {
      if (this.fallback) this.fallback.browser.close();
    } catch {}
    try {
      if (this.view) {
        this.win.contentView.removeChildView(this.view);
        this.view.webContents.close();
      }
    } catch {}
    this.browser = null;
    this.fallback = null;
    this.view = null;
    this.page = null;
  }
}

function isUiPage(url: string) {
  return (
    url.startsWith('http://localhost:5173') ||
    url.startsWith('data:text/html') ||
    url.includes('/app/renderer/')
  );
}
