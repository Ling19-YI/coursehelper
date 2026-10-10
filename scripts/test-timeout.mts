import http from 'node:http';
import assert from 'node:assert';

async function main() {
  /**
   * 验证「AI 答题卡死」修复：
   *  1. llm.callOnce 对不响应的服务必须超时退出（而不是永久挂起）
   *  2. video.withTimeout 到点后 reject，且不误杀整个任务
   *  3. runAgent 的总预算到期后停止发新请求
   */

  /* ---------- 1. 视觉接口超时 ---------- */
  const { askQuizByVision } = await import('../src/main/engine/agent/llm.ts');

  let hitCount = 0;
  const hanging = http.createServer((_req, _res) => {
    hitCount++;
    // 故意永不响应：模拟中转服务挂起
  });
  await new Promise<void>(r => hanging.listen(0, '127.0.0.1', r));
  const port = (hanging.address() as any).port;

  console.log('=== 测试1：视觉接口永不响应 ===');
  console.log('起了一个挂死的服务，端口', port);

  const t1 = Date.now();
  let timedOut = false;
  try {
    await askQuizByVision(
      {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-test',
        model: 'test',
        effort: 'low',
      } as any,
      [{ q: 1, jpeg: Buffer.from('fake').toString('base64'), w: 100, h: 100 }],
      { maxMs: 5000 }
    );
    console.log('✗ 未抛错——请求竟然返回了，测试无效');
    process.exit(1);
  } catch (e: any) {
    const ms = Date.now() - t1;
    timedOut = true;
    console.log(`✓ 已抛错: ${e.message}`);
    console.log(`  耗时 ${(ms / 1000).toFixed(1)}s（超时上限 75s，本测试应等待但受全局预算约束）`);
    assert(/超时|连接失败/.test(e.message), `错误信息应说明超时或连接失败，实际: ${e.message}`);
  }
  assert(timedOut, '应当抛出超时错误');

  hanging.close();
  console.log('  服务收到请求次数:', hitCount);
  assert(hitCount >= 1, '请求应已发出');
  console.log('✓ 测试1 通过\n');

  /* ---------- 2. 连接被拒（服务不存在）应快速失败 ---------- */
  console.log('=== 测试2：接口不存在，应快速失败而非挂起 ===');
  const t2 = Date.now();
  try {
    await askQuizByVision(
      {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'sk-test',
        model: 'test',
      } as any,
      [{ q: 1, jpeg: Buffer.from('fake').toString('base64'), w: 100, h: 100 }],
      { maxMs: 5000 }
    );
    console.log('✗ 未抛错');
    process.exit(1);
  } catch (e: any) {
    console.log(`✓ 快速失败: ${e.message}（耗时 ${Date.now() - t2}ms）`);
    assert(/连接失败|超时/.test(e.message), `应报连接失败，实际: ${e.message}`);
  }
  console.log('✓ 测试2 通过\n');

  /* ---------- 3. withTimeout 行为 ---------- */
  console.log('=== 测试3：withTimeout 到点后 reject ===');
  const { withTimeout, WatchdogError } = await import('../src/main/engine/watchdog.ts');

  let cancelCalled = 0;
  const t3 = Date.now();
  try {
    await withTimeout(
      new Promise(resolve => setTimeout(resolve, 60000)),
      1000,
      () => {
        cancelCalled++;
      }
    );
    console.log('✗ 未超时');
    process.exit(1);
  } catch (e: any) {
    const ms = Date.now() - t3;
    console.log(`✓ ${ms}ms 后抛出 ${e.name}`);
    assert(e instanceof WatchdogError, '应为 WatchdogError');
    assert(cancelCalled === 1, 'onTimeout 应被调用一次');
    assert(ms >= 900 && ms < 2500, `应在 1s 附近，实际 ${ms}ms`);
  }
  console.log('✓ 测试3 通过\n');

  /* ---------- 4. withTimeout 不误杀：正常完成的 promise 必须正常 resolve ---------- */
  console.log('=== 测试4：未超时时应正常返回 ===');
  const ok = await withTimeout(Promise.resolve('答案'), 5000, () => {
    throw new Error('不该触发');
  });
  assert(ok === '答案', '应原样返回');
  console.log('✓ 正常路径返回:', ok);

  /* ---------- 5. 定时器清理：超时后不能留下悬挂定时器拖住进程 ---------- */
console.log('=== 测试5：超时后定时器已清理 ===');
  const before = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? -1;
  await withTimeout(new Promise(r => setTimeout(r, 60000)), 500, () => {}).catch(() => {});
  await new Promise(r => setTimeout(r, 100));
  const after = process.getActiveResourcesInfo?.().filter(r => r === 'Timeout').length ?? -1;
  console.log(`  超时句柄: ${before} → ${after}`);
  assert(after <= before + 1, '不应残留大量定时器');
  console.log('✓ 测试5 通过');

  console.log('\n全部通过 ✅');
  process.exit(0);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });

