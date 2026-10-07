import type { Page, FrameLocator } from 'playwright';
import type { EngineHooks } from './hooks';

export function getQuizFrame(page: Page): FrameLocator {
  return page
    .frameLocator('#iframe')
    .frameLocator('iframe')
    .frameLocator('iframe[name="frame_content"], iframe');
}

export async function getQuizPageText(page: Page): Promise<string> {
  return (await getQuizFrame(page).locator('body').textContent({ timeout: 5000 })) || '';
}

export async function askDeepSeekForPage(apiKey: string, pageText: string): Promise<any[]> {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            '你是答题助手。分析测验网页文本，选出每题正确答案。返回JSON: [{"question":1,"answer":"A","note":"解释"}]。answer: 单选="A",多选="AB",判断="对"/"错",填空写文字。不确定填"?"。只输出JSON。',
        },
        { role: 'user', content: `回答以下测验:\n\n${pageText}` },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek API ${resp.status}`);
  const raw = ((await resp.json()) as any).choices?.[0]?.message?.content || '';
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('AI 格式错误: ' + raw.substring(0, 100));
  return JSON.parse(m[0]);
}

export async function clickAnswersByLabel(page: Page, h: EngineHooks, answers: any[]): Promise<number> {
  const quiz = getQuizFrame(page);
  let clicked = 0;
  for (const item of answers) {
    h.ctl.throwIfStopped();
    const ans = String(item.answer || '').trim().toUpperCase();
    if (!ans || ans === '?' || ans === '？') {
      h.log('info', `      Q${item.question}: 跳过`);
      continue;
    }
    const qIdx = item.question - 1;
    for (const ch of ans.replace(/[^A-H]/g, '').split('')) {
      let ok = false;
      try {
        const o = quiz.locator(`[aria-label*="${ch} "], [aria-label^="${ch}"]`);
        if ((await o.count()) > qIdx) {
          await o.nth(qIdx).click({ force: true, timeout: 2000 });
          ok = true;
        }
      } catch {}
      if (!ok)
        try {
          const ls = quiz.locator('ul, ol, [role="list"]').filter({ has: quiz.locator('[role="radio"]') });
          if (qIdx < (await ls.count())) {
            const r = ls.nth(qIdx).locator('[role="radio"]');
            const li = 'ABCDEFGH'.indexOf(ch);
            if (li >= 0 && li < (await r.count())) {
              await r.nth(li).click({ force: true, timeout: 2000 });
              ok = true;
            }
          }
        } catch {}
      if (!ok)
        try {
          const ar = quiz.locator('[role="radio"], input[type="radio"]');
          const idx = qIdx * 4 + 'ABCDEFGH'.indexOf(ch);
          if (idx >= 0 && idx < (await ar.count())) {
            await ar.nth(idx).click({ force: true, timeout: 2000 });
            ok = true;
          }
        } catch {}
      if (!ok)
        try {
          const tx = quiz.getByText(new RegExp(`^${ch}\\s`));
          if ((await tx.count()) > qIdx) {
            await tx.nth(qIdx).click({ force: true, timeout: 2000 });
            ok = true;
          }
        } catch {}
      if (!ok)
        try {
          const op = quiz.getByRole('option');
          const oi = 15 + (qIdx - 15) * 4 + 'ABCDEFGH'.indexOf(ch);
          if (oi >= 15 && oi < (await op.count())) {
            await op.nth(oi).click({ force: true, timeout: 2000 });
            ok = true;
          }
        } catch {}
      if (ok) {
        clicked++;
        h.log('info', `      Q${item.question} ${ch} ✓`);
      }
    }
  }
  return clicked;
}

export async function isQuizPage(page: Page): Promise<boolean> {
  try {
    const t = await getQuizPageText(page);
    return (
      (t.includes('章节测验') || t.includes('待完成')) &&
      (t.includes('单选题') || t.includes('多选题') || t.includes('判断题'))
    );
  } catch {
    return false;
  }
}

export async function submitQuiz(page: Page, h: EngineHooks): Promise<boolean> {
  try {
    await getQuizFrame(page)
      .locator('button:has-text("提交"), a:has-text("提交")')
      .first()
      .click({ timeout: 3000 });
    await h.ctl.sleep(2000);
    const c = page.locator('.layui-layer-btn0, button:has-text("确定")');
    if ((await c.count()) > 0) {
      await c.first().click({ timeout: 2000 });
      await h.ctl.sleep(2000);
    }
    h.log('ok', '    ✓ 已提交');
    return true;
  } catch {
    h.log('warn', '    ⚠ 提交失败');
    return false;
  }
}

export async function handleQuiz(
  page: Page,
  h: EngineHooks,
  apiKey: string | undefined
): Promise<{ answered: number; success: boolean }> {
  h.log('info', '    → 检测到答题页面');
  if (!apiKey) {
    h.log('warn', '    ⚠ 未配置 DeepSeek API Key，跳过答题');
    return { answered: 0, success: false };
  }
  const text = await getQuizPageText(page);
  h.log('info', `    → 页面 ${text.length} 字符`);
  let answers: any[];
  try {
    answers = await askDeepSeekForPage(apiKey, text);
  } catch (e: any) {
    h.log('error', `    ✗ AI: ${e.message}`);
    return { answered: 0, success: false };
  }
  if (!answers?.length) {
    h.log('warn', '    ⚠ AI 无返回');
    return { answered: 0, success: false };
  }
  h.log('info', `    → AI 给出 ${answers.length} 题答案`);
  const clicked = await clickAnswersByLabel(page, h, answers);
  return { answered: clicked, success: await submitQuiz(page, h) };
}
