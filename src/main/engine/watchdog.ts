/**
 * 通用超时看门狗。
 *
 * 抽出独立模块是为了可测试：本文件不依赖 electron / playwright，
 * 能在纯 Node 环境直接跑单元测试。
 */

export class WatchdogError extends Error {
  constructor(public readonly ms: number) {
    super(`看门狗超时 ${ms}ms`);
    this.name = 'WatchdogError';
  }
}

/**
 * 给 promise 加超时上限。
 *
 * 到点后调用 onTimeout（用于触发作用域内取消），并立即 reject，
 * 让调用方马上拿回控制权，而不是干等。
 *
 * 注意：不要用「全局停止」来做超时中止——那会连整个任务一起杀掉。
 * 超时应当只终止当前这步操作，让上层有机会继续后续流程。
 *
 * 无论 resolve 还是 reject 都会清理定时器，避免事件循环被吊住。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {}
      reject(new WatchdogError(ms));
    }, ms);
    p.then(
      v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}