export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 推理强度：low 准但慢，none 快但易误判 */
  effort?: 'low' | 'none';
  /** 单次最多回答几题，超出则分批调用，控制总耗时 */
  batchSize?: number;
}

/** 一道题的答案，含所有需要点击的点（多选会有多个） */
export interface QuizAnswer {
  /** 题号（从 1 开始） */
  q: number;
  /** 选项字母，如 "A" / "AB"；判断题为 "对"/"错"；填空为待填文本 */
  answer: string;
  /** 需要点击的坐标（截图坐标系）；多选题有多个，全部要点 */
  points: Array<{ x: number; y: number }>;
  /**
   * 填空题：按顺序给出每个空要填的内容。
   * 例：answer="Beijing"（单空）或 answer="北京|上海"（多空，用 | 分隔）
   */
  fills?: string[];
  note?: string;
}

/**
 * 从模型输出里提取答案数组，容忍常见脏输出：
 * - markdown 代码块包裹
 * - 尾随逗号
 * - 输出被 max_tokens 截断（补齐括号，保留已完整的前 N 题）
 */
/** 归一化：统一出 points 数组（兼容 points / x+y 两种形态），并解析 fills */
function norm(a: any): QuizAnswer | null {
  const q = Number(a?.q) || 0;
  const answer = String(a?.answer ?? '').trim();
  if (q <= 0 || !answer) return null;
  const pts: Array<{ x: number; y: number }> = [];
  if (Array.isArray(a?.points)) {
    for (const p of a.points) {
      if (p && typeof p.x === 'number' && typeof p.y === 'number') pts.push({ x: p.x, y: p.y });
    }
  }
  if (!pts.length && typeof a?.x === 'number' && typeof a?.y === 'number') {
    pts.push({ x: a.x, y: a.y });
  }
  // fills：数组或 "甲|乙" 分隔文本均可
  let fills: string[] | undefined;
  if (Array.isArray(a?.fills) && a.fills.length) {
    fills = a.fills.map((f: any) => String(f ?? '').trim()).filter(Boolean);
  } else if (typeof a?.fills === 'string' && a.fills.trim()) {
    fills = a.fills.split('|').map((s: string) => s.trim()).filter(Boolean);
  }
  if (!fills && /\uff5c|\|/.test(answer)) {
    fills = answer.split('|').map(s => s.trim()).filter(Boolean);
  }
  return {
    q,
    answer,
    points: pts,
    fills: fills && fills.length ? fills : undefined,
    note: a?.note ? String(a.note).slice(0, 80) : undefined,
  };
}

function extractAnswers(raw: string): QuizAnswer[] {
  const s = String(raw || '');
  if (!s.trim()) return [];

  let candidates: string[] = [];
  const fenced = s.match(/\[[\s\S]*\]/);
  if (fenced) candidates.push(fenced[0]);
  const fromBracket = s.slice(s.indexOf('['));
  if (fromBracket && fromBracket !== fenced?.[0]) candidates.push(fromBracket);

  for (const c of candidates) {
    // 补齐被截断的括号/引号
    let t = c.replace(/,\s*]/g, ']').trim();
    const opens = (t.match(/\{/g) || []).length;
    const closes = (t.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) t += '}';
    t += ']'.repeat(Math.max(0, (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length));

    const collect = (arr: any[]): QuizAnswer[] =>
      arr.map(norm).filter((x): x is QuizAnswer => x !== null);

    try {
      const v = JSON.parse(t);
      if (Array.isArray(v) && v.length) return collect(v);
    } catch {
      // 输出被截断时最后一条是坏的，退化为逐条提取 {..}
      const items: any[] = [];
      for (const m of t.matchAll(/\{[^{}]*\}/g)) {
        try {
          const o = JSON.parse(m[0]);
          if (o && (o.q || o.answer)) items.push(o);
        } catch {}
      }
      if (items.length) return collect(items);
    }
  }
  return [];
}

/** 一张题图 */
export interface ShotInput {
  jpeg: string;
  w: number;
  h: number;
  cropped?: boolean;
  /** 该图对应的题号，用于多图批处理时对齐 */
  q?: number;
}

/**
 * 调用多模态模型作答。
 *
 * 实测（真实 16 题作业，总高 7959px）：
 * - 整份作业拼成一张长图 → 等比缩到 240px 宽仍返回 0 题（长宽比 1:10，视觉模型读不出）
 * - 单图超 8 题 → max_tokens 被推理过程吃光，输出截断
 * 因此必须「每题一图」并分批发送；一次请求可携带多张图，显著减少往返。
 */
export async function askQuizByVision(
  cfg: VisionConfig,
  shots: ShotInput | ShotInput[],
  opts: { maxMs?: number } = {}
): Promise<QuizAnswer[]> {
  const started = Date.now();
  const list = Array.isArray(shots) ? shots : [shots];
  if (!list.length) throw new Error('未提供截图');

  // 多图时明确标出每张图对应的题号，避免模型把题号错位
  const imageDesc =
    list.length === 1
      ? `下面这张图包含第 ${list[0].q ?? 1} 题起的题目`
      : `下面依次是第 ${list.map((s, i) => s.q ?? i + 1).join('、')} 题的图片，每张图一道题`;

  const content: any[] = [
    {
      type: 'text',
      text:
        `${imageDesc}。请回答这些题目。\n` +
        '输出格式：\n' +
        '  选择题：[{"q":1,"answer":"A","points":[{"x":120,"y":300}]}]\n' +
        '  多选题：[{"q":2,"answer":"AC","points":[{"x":80,"y":200},{"x":80,"y":320}]}]\n' +
        '  填空题：[{"q":3,"answer":"北京","fills":["北京"],"points":[]}]\n' +
        '规则：\n' +
        '1. q 用题目自身的题号（题干前的数字），不要重新编号\n' +
        '2. 判断题 answer 给 "对" 或 "错"，且不要给 points（系统按文本匹配）\n' +
        '3. 填空题（题干里有横线或空白需要输入文字）：不要给 points，' +
        '把每个空按从左到右的顺序放进 fills 数组；只有一个空时 answer 直接写该空内容\n' +
        '4. 选择题的 points 坐标基于「该题所在那张图」的尺寸（见下方），取正确选项的正中间\n' +
        '5. 填空内容用题目的语言作答（中文题填中文，英文题填英文）\n' +
        '6. 完全无法确定时 answer 填 "?"\n' +
        '7. 只输出JSON，不要任何解释文字\n' +
        '图片尺寸：' +
        list.map((s, i) => `图${i + 1}=${s.w}x${s.h}`).join('，'),
    },
    ...list.map((s, i) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${s.jpeg}` },
    })),
  ];

  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content: '你是超星学习通测验答题专家。看图作答，擅长英语、医学、马克思主义、护理、计算机等课程。严格只输出JSON数组。',
      },
      { role: 'user', content },
    ],
    temperature: 0,
    // 速度/准确权衡（实测 4 题截图）：
    //   none →  4.2s，但多选变全选、判断题答反，准确率不可用
    //   low  → 16.7s，准确率可用
    reasoning_effort: (cfg.effort ?? 'low') as 'low' | 'none',
    max_tokens: 3000,
  };

  const parsed = await callOnce(cfg, list, opts, body);

  if (!parsed.length) {
    throw new Error(`模型未返回答案（${((Date.now() - started) / 1000).toFixed(1)}s）`);
  }
  return parsed;
}

/** 单次调用 */
async function callOnce(cfg: VisionConfig, list: ShotInput[], _opts: any, body: any): Promise<QuizAnswer[]> {
  const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`视觉接口 ${resp.status}${resp.status === 401 ? '（key 无效）' : ''}`);
  }
  const json: any = await resp.json();
  const choice = json?.choices?.[0];
  const raw: string = choice?.message?.content || '';
  const finish = choice?.finish_reason || '';
  const parsed = extractAnswers(raw);
  if (!parsed.length && finish === 'length' && !_opts.__retried) {
    // 输出被截断：提高 max_tokens 重试一次
    body.max_tokens = Math.min(6000, (body.max_tokens || 3000) * 2);
    body.messages[1].content[0].text +=
      '\n注意：上一轮输出被截断，请务必只输出JSON，note 字段不要写，务必给全部题目作答。';
    return callOnce(cfg, list, { ..._opts, __retried: true }, body);
  }
  return parsed;
}