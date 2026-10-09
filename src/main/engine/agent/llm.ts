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
  /** 选项字母，如 "A" / "AB"；判断题为 "对"/"错"；填空为文本 */
  answer: string;
  /** 需要点击的坐标（截图坐标系）；多选题有多个，全部要点 */
  points: Array<{ x: number; y: number }>;
  note?: string;
}

/**
 * 从模型输出里提取答案数组，容忍常见脏输出：
 * - markdown 代码块包裹
 * - 尾随逗号
 * - 输出被 max_tokens 截断（补齐括号，保留已完整的前 N 题）
 */
/** 归一化：统一出 points 数组（兼容 points / x+y 两种形态） */
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
  return {
    q,
    answer,
    points: pts,
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

/** 调用多模态模型，传入截图，返回结构化答案 */
export async function askQuizByVision(
  cfg: VisionConfig,
  shot: { jpeg: string; w: number; h: number; cropped: boolean },
  opts: { maxMs?: number } = {}
): Promise<QuizAnswer[]> {
  const started = Date.now();
  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'system',
        content:
          '你是超星学习通测验答题专家。看图作答，擅长英语、医学、马克思主义、护理、计算机等课程。' +
          '严格只输出JSON数组，不要任何其他文字或解释。',
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '请看这张测验截图并回答所有题目。\n' +
              '输出格式：\n' +
              '  单选/判断：[{"q":1,"answer":"A","x":120,"y":300}]\n' +
              '  多选（每个正确选项都要给一个坐标）：[{"q":2,"answer":"AC","points":[{"x":80,"y":200},{"x":80,"y":320]}]\n' +
              '规则：\n' +
              '1. q 是题号，从 1 开始，按页面从上到下顺序\n' +
              '2. answer 单选给一个字母，多选给多个字母如 "AC"，判断题给 "对" 或 "错"，填空题给要填的内容\n' +
              `3. 坐标必须基于这张图片的尺寸 ${shot.w}x${shot.h}，取正确选项的正中间，不要取题目文字位置\n` +
              '4. 判断题不要给坐标（系统会按文本匹配），其余题型用 points 或 x/y\n' +
              '5. 完全无法确定时 answer 填 "?"\n' +
              '6. 只输出JSON，不要任何解释文字',
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${shot.jpeg}` },
          },
        ],
      },
    ],
    temperature: 0,
    // 速度/准确权衡（实测 4 题截图）：
    //   none →  4.2s，但多选变全选、判断题答反，准确率不可用
    //   low  → 16.7s，准确率可用
    // 选 low：答题正确率优先，由调用方通过分批控制总耗时。
    // 若换用非思维链模型，此参数会被忽略。
    reasoning_effort: 'low' as const,
    max_tokens: 3000,
  };

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
  const ms = Date.now() - started;

  const parsed = extractAnswers(raw);

  if (!parsed.length) {
    const why =
      finish === 'length'
        ? '输出被截断（思考过程占用预算），建议减少题目或换更快的模型'
        : raw
          ? `未找到 JSON：${raw.substring(0, 50)}`
          : '空响应';
    throw new Error(`模型未返回答案（${(ms / 1000).toFixed(1)}s，${why}）`);
  }

  return parsed;
}