import { app, BrowserWindow, WebContentsView } from 'electron';

app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const pageUrl = process.argv[2];

async function main() {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'CourseHelper Spike',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
  });

  win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="margin:0;background:#0b1220;color:#9fb3d1;font:14px sans-serif;padding:16px">' +
          '<h3 style="color:#e2e8f0">CourseHelper 控制面板（spike 占位）</h3>' +
          '<div id="st">CDP: 9222</div>' +
          '<p>右侧为 WebContentsView，由 Playwright connectOverCDP 驱动</p>' +
          '</body>'
      )
  );

  const view = new WebContentsView({
    webPreferences: { autoplayPolicy: 'no-user-gesture-required' },
  });
  win.contentView.addChildView(view);

  const layout = () => {
    const [w, h] = win.getContentSize();
    const panelW = Math.min(500, Math.floor(w / 3));
    view.setBounds({ x: panelW, y: 0, width: Math.max(0, w - panelW), height: h });
  };
  layout();
  win.on('resize', layout);

  if (pageUrl) {
    try {
      await view.webContents.loadURL(pageUrl);
    } catch (e) {
      console.error('[spike] load failed:', e);
    }
  }

  win.on('closed', () => app.quit());
}

main().catch(e => {
  console.error('[spike] fatal:', e);
  app.exit(1);
});
