export class StopError extends Error {
  constructor() {
    super('任务已停止');
    this.name = 'StopError';
  }
}

export const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class TaskControl {
  private stopped = false;
  private pausedFlag = false;
  onPausedChange?: (paused: boolean) => void;

  /** 任务开始前重置（同一引擎实例可复用） */
  reset() {
    this.stopped = false;
    this.pausedFlag = false;
  }

  stop() {
    this.stopped = true;
    this.pausedFlag = false;
  }

  pause() {
    if (!this.stopped) {
      this.pausedFlag = true;
      this.onPausedChange?.(true);
    }
  }

  resume() {
    this.pausedFlag = false;
    this.onPausedChange?.(false);
  }

  get isPaused() {
    return this.pausedFlag;
  }

  get isStopped() {
    return this.stopped;
  }

  throwIfStopped() {
    if (this.stopped) throw new StopError();
  }

  /** 可中断 sleep：切片 200ms，随时响应 stop/pause */
  async sleep(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.throwIfStopped();
      while (this.pausedFlag && !this.stopped) await delay(200);
      this.throwIfStopped();
      await delay(Math.min(200, Math.max(1, end - Date.now())));
    }
  }
}
