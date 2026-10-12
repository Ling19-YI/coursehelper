import type { Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export interface VideoState {
  ct: number;
  d: number;
  paused: boolean;
  ended: boolean;
  rate: number;
  focus: boolean;
  vis: string;
  err: string;
}

/** 目标倍速：写在每个页面的 window.__kaRate 上，保活 ticker 与 forcePlay 都会维持它 */
let desiredRate = 1;

const clampRate = (r: number) => Math.min(2, Math.max(1, Number(r) || 1));

/** 设置倍速（页面重载后需重新调用）：>1x 持续维持，≤1x 一律恢复原速 */
export async function setVideoRate(page: Page, rate: number): Promise<void> {
  desiredRate = clampRate(rate);
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((r: number) => {
        (window as any).__kaRate = r;
        const want = r > 1 ? r : 1;
        const vs = document.querySelectorAll('video');
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i] as HTMLVideoElement;
          try {
            if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
          } catch (e) {}
        }
      }, desiredRate);
    } catch {}
  }
}

/** 强制播放：读取视频状态，若暂停则 play()，并维持目标倍速与静音 */
export async function forcePlay(
  frame: Frame,
  wantMuted = true,
  targetOnly = false
): Promise<VideoState | null> {
  return await frame.evaluate((args: { mute: boolean; targetOnly: boolean }) => {
    // 「现在在播哪个视频」必须有唯一定义。标在 DOM 上的 data-ch-target
    // 就是那个定义（由 video.ts 的 markTargetVideo 写入），这里与保活 ticker
    // 都遵守它。
    //
    // 旧实现直接 querySelector('video')，不做任何过滤：同一章节页里并列多个
    // 任务点视频时（实机见过两个 ananas/modules/video iframe），它可能与
    // probeVideo 选中不同的那个，于是两个视频各播各的——用户看到的就是
    // 「上下两个视频来回切换」。
    let v = document.querySelector('video[data-ch-target="1"]') as HTMLVideoElement | null;
    if (!v && !args.targetOnly) {
      // 尚未打标时退化为「第一个可见且未结束的」。比原来的「无条件取第一个」
      // 稳一些：至少不会选中页面里已播完或纯装饰的 <video>。
      const all = document.querySelectorAll('video');
      for (let i = 0; i < all.length; i++) {
        const c = all[i] as HTMLVideoElement;
        const r = c.getBoundingClientRect();
        if (r.width < 100 || r.height < 60) continue;
        if (c.ended) continue;
        v = c;
        break;
      }
    }
    if (!v) return null;
    let err = '';
    // 平台播放器可能把倍速改回 1x，这里纠正回目标值（≤1x 时恢复原速）
    try {
      const target = Number((window as any).__kaRate) || 1;
      const want = target > 1 ? target : 1;
      if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
    } catch {}
    // 静音：每次都重新设置。平台在切换清晰度或音轨时会重置 muted，
    // 只在初始化时设一次会被悄悄解除。
    if (args.mute && !v.muted) {
      try {
        v.muted = true;
        v.volume = 0;
      } catch {}
    }
    if (v.paused) {
      try {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch((e: any) => { err = String(e?.name || e?.message || e); });
      } catch (e: any) {
        err = String(e?.name || e?.message || e);
      }
    }
    return {
      ct: v.currentTime,
      d: v.duration || 0,
      paused: v.paused,
      ended: v.ended,
      rate: v.playbackRate,
      muted: v.muted,
      focus: document.hasFocus(),
      vis: document.visibilityState,
      err,
    };
  }, { mute: wantMuted, targetOnly });
}

/** 唤醒：合成事件 + forcePlay + 兜底点击播放按钮 */
export async function wakeUp(page: Page, frame: Frame, wantMuted = true): Promise<VideoState | null> {
  // 兜底：扫码/验证码弹窗期间绝不能派发事件或点击，
  // 否则二维码会被判定环境变化而反复刷新。这里拦一道，
  // 避免其他调用路径绕过 video.ts 的弹窗检测。
  try {
    const blocked = await frame.evaluate(() => {
      const kw = /扫码|扫描二维码|手机.{0,4}确认|验证码|人脸|安全验证|身份验证/;
      for (const el of Array.from(document.querySelectorAll(
        '.layui-layer,.popDiv,.markPopup,.maskDiv,.modal,.ant-modal,.el-dialog,[class*="scanCode"],[class*="verify"]'
      ))) {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 60) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const t = ((el as HTMLElement).innerText || el.textContent || '').trim();
        if (t.length >= 4 && kw.test(t)) return true;
      }
      return false;
    });
    if (blocked) return null;
  } catch {}

  try {
    await frame.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focusin'));
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('mousemove'));
    });
  } catch {}
  await new Promise(r => setTimeout(r, 800));
  let s = await forcePlay(frame, wantMuted);
  if (s?.paused) {
    try {
      const v = await frame.$('video');
      if (v) await v.click({ force: true, timeout: 2000 });
    } catch {}
    await new Promise(r => setTimeout(r, 1200));
    s = await forcePlay(frame, wantMuted);
  }
  if (s?.paused) {
    for (const sel of ['.play-btn', '.prism-big-play-btn', '.vjs-big-play-button', '[class*="big-play"]', '[class*="playBtn"]']) {
      try {
        const b = await frame.$(sel);
        if (b) {
          await b.click({ force: true, timeout: 1500 });
          await new Promise(r => setTimeout(r, 1000));
          s = await forcePlay(frame, wantMuted);
          if (s && !s.paused) break;
        }
      } catch {}
    }
  }
  return s;
}

/**
 * 暂停堆栈诊断 + 300ms 页内保活 ticker（对抗平台 mouseleave 暂停）
 * 注意：ticker 必须挂在 window 上（旧版误用未定义的 win 变量导致注入即抛错）
 */
export const SPY_JS = `(() => {
  if (window.__spyOn) return 'already';
  window.__spyOn = true;
  window.__pauses = [];
  window.__plays = 0;
  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    try {
      window.__pauses.push({ kind: 'call', stack: String(new Error().stack || '').split('\\n').slice(1, 4).join(' >> ') });
      if (window.__pauses.length > 8) window.__pauses.shift();
    } catch (e) {}
    return origPause.apply(this, arguments);
  };
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    try { window.__plays = window.__plays + 1; } catch (e) {}
    return origPlay.apply(this, arguments);
  };
  document.addEventListener('pause', function (e) {
    try {
      const el = e.target;
      if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
        window.__pauses.push({ kind: 'evt', trusted: e.isTrusted, ct: +(el.currentTime || 0).toFixed(2) });
        if (window.__pauses.length > 8) window.__pauses.shift();
      }
    } catch (err) {}
  }, true);
  if (!window.__kaOn) {
    window.__kaOn = true;
    if (window.__kaPaused === undefined) window.__kaPaused = false;
    setInterval(function () {
      try {
        if (window.__kaPaused) return;
        const doc = window.document;
        // 只驱动「当前目标」那一个视频。
        // 旧实现把页面上所有 <video> 全量拉起：同一章节页里并列多个任务点的
        // 视频（实测见过两个）会同时往前跑——diag 里两条 vids 都是
        // paused=false、ct 都在涨，界面上就是「上下两个视频来回切换」。
        let target = doc.querySelector('video[data-ch-target="1"]');
        if (!target) {
          // 还没打标时退化为「第一个可见且未结束的」，与 forcePlay 的回退
          // 路径保持一致；比全量拉起安全，又不至于让保活完全失效。
          const cands = doc.querySelectorAll('video');
          for (let i = 0; i < cands.length; i++) {
            const c = cands[i];
            let cr = null;
            try { cr = c.getBoundingClientRect(); } catch (e) { cr = null; }
            if (!cr || cr.width < 100 || cr.height < 60) continue;
            if (c.ended) continue;
            target = c;
            break;
          }
        }
        const vs = doc.querySelectorAll('video');
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i];
          try {
            if (target && v !== target) {
              // 非目标视频一律停住，杜绝同页两个任务点同时播
              if (!v.paused) v.pause();
              continue;
            }
            if (v.duration > 0 && !v.ended && v.paused) v.play().catch(function () {});
            var kr = Number(window.__kaRate) || 1;
            var want = kr > 1 ? kr : 1;
            if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want;
          } catch (e) {}
        }
        const ev = ['mousemove', 'mouseover', 'mouseenter'];
        for (let i = 0; i < ev.length; i++) {
          try { doc.dispatchEvent(new MouseEvent(ev[i], { bubbles: true, clientX: 420, clientY: 300 })); } catch (e) {}
        }
        try { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focusin')); } catch (e) {}
      } catch (e) {}
    }, 300);
  }
  return 'ok';
})()`;

export async function installPauseSpy(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(SPY_JS);
    } catch {}
  }
}

/**
 * 任务暂停/恢复时同步媒体播放：
 * pause 时同时置 __kaPaused 让保活 ticker 让位，否则 ticker 会 300ms 内又拉起来
 */
export async function setMediaPlayback(page: Page, play: boolean): Promise<void> {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate((p: boolean) => {
        (window as any).__kaPaused = !p;
        const vs = document.querySelectorAll('video');
        for (let i = 0; i < vs.length; i++) {
          const v = vs[i] as HTMLVideoElement;
          try {
            if (p) {
              if (v.paused && v.duration > 0 && !v.ended) v.play().catch(() => {});
            } else {
              if (!v.paused) v.pause();
            }
          } catch (e) {}
        }
      }, play);
    } catch {}
  }
}

export const DIAG_JS = `(async () => {
  const install = function (win) {
    try {
      if (win.__spyOn) return;
      win.__spyOn = true;
      win.__pauses = [];
      win.__plays = 0;
      const origPause = HTMLMediaElement.prototype.pause;
      HTMLMediaElement.prototype.pause = function () {
        try {
          win.__pauses.push({ stack: String(new Error().stack || '').slice(0, 400) });
          if (win.__pauses.length > 6) win.__pauses.shift();
        } catch (e) {}
        return origPause.apply(this, arguments);
      };
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        try { win.__plays = win.__plays + 1; } catch (e) {}
        return origPlay.apply(this, arguments);
      };
    } catch (e) {}
  };
  const out = [];
  let target = null;
  const walk = function (win, path, depth) {
    if (depth > 4) return;
    try {
      const doc = win.document;
      if (!doc) return;
      install(win);
      const vids = doc.querySelectorAll('video');
      for (let i = 0; i < vids.length; i++) {
        const v = vids[i];
        let buf = -1; try { buf = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch (e) {}
        let rect = []; try { const r = v.getBoundingClientRect(); rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; } catch (e) {}
        out.push({ path: path, i: i, ct: +(v.currentTime || 0).toFixed(2), d: +(v.duration || 0).toFixed(1),
          rs: v.readyState, paused: v.paused, seek: v.seeking, buf: +(+buf).toFixed(1),
          w: v.videoWidth, h: v.videoHeight, rect: rect, src: String(v.currentSrc || v.src || '').slice(-60) });
        if (!target && v.duration > 0) target = { v: v, win: win };
      }
      const ifr = doc.querySelectorAll('iframe');
      for (let i = 0; i < ifr.length; i++) { try { if (ifr[i].contentWindow) walk(ifr[i].contentWindow, path + '>if' + i, depth + 1); } catch (e) {} }
    } catch (e) {}
  };
  walk(window, 'top', 0);
  const res = { vids: out, url: String(location.href).slice(0, 80), focus: document.hasFocus(), vis: document.visibilityState };
  if (target) {
    const v = target.v, win = target.win;
    res.before = { ct: +(v.currentTime || 0).toFixed(2), paused: v.paused, seek: v.seeking, rate: v.playbackRate, rs: v.readyState };
    let playErr = '';
    try { const pr = v.play(); if (pr && pr.catch) pr.catch(function (e) { playErr = String((e && e.name) || e); }); } catch (e) { playErr = String((e && e.name) || e); }
    await new Promise(function (r) { setTimeout(r, 2500); });
    res.after = { ct: +(v.currentTime || 0).toFixed(2), paused: v.paused, seek: v.seeking, rate: v.playbackRate, rs: v.readyState };
    res.playErr = playErr;
    res.pauses = (win.__pauses || []).slice(-5);
    res.plays = win.__plays || 0;
  }
  return res;
})()`;

export async function diagVideo(page: Page, tag: string, diagDir: string): Promise<string | null> {
  try {
    const info: any = await page.evaluate(DIAG_JS);
    try {
      if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true });
      const file = path.join(diagDir, `shot_${tag}.png`);
      await page.screenshot({ path: file });
      return `${JSON.stringify(info)} → ${file}`;
    } catch (e: any) {
      return `${JSON.stringify(info)} (截图失败: ${e.message})`;
    }
  } catch (e: any) {
    return `诊断失败: ${e.message}`;
  }
}
