# Agent 模块（预留能力，当前未接线）

> **这不是死代码。** `src/` 下没有任何文件 import 本目录，这是**有意的**——
> 它是为「结构化解析失效的界面」和后续新功能预留的基座。
> 清理代码时请保留整目录。

## 它做什么

一套**数据驱动的视觉 Agent 循环**。给定一个「目标」（`AgentGoal`），它自己完成：

```
找题目容器 → 逐题截图 → 分批送多模态模型 → 坐标吸附点击 → 判定完成
```

策略上刻意**不做逐步交互**：实测单次视觉调用要 14~38 秒，逐步交互必然
压垮限时测验。所以是一次性拿全部答案、再批量点击。

## 为什么需要它

现有的答题链（`../quiz.ts` 的 `handleQuiz`）走的是**结构化解析**：
从 DOM 里读题干与选项，然后依次尝试 题库 → 文字模型 → 截图识别。

这条路的前提是「DOM 能读」。一旦遇到下面这些情况会**直接失效**：

- 平台改版，题目容器结构变了（`extractQuestions` 匹配不到）
- 富交互题型：拖拽排序、连线、点选区域
- 纯 Canvas / 图片渲染的界面，DOM 里没有任何可用语义
- 新平台（雨课堂等）的答题界面（见 `feat/multi-platform` 分支的 PlatformDriver 思路）

纯视觉 Agent **不依赖 DOM 语义**——它只看渲染结果，用坐标操作。所以它是兜底，
也是以后扩展新界面能力的基座。

## 接口

### 入口

```ts
runAgent(
  cfg: VisionConfig,
  page: Page,
  goal: AgentGoal,
  deps: {
    log(level: 'info' | 'warn' | 'error' | 'ok', msg: string): void;
    checkpoint(): void;                        // 用于检查任务是否被用户停止
    sleep(ms: number): Promise<void>;
  }
): Promise<AgentResult>
```

`AgentResult` = `{ ok, answered, clicked, steps, ms, reason }`

### 现成的目标

```ts
quizGoal(doneSelector?: string): AgentGoal
```

`doneSelector` 只用于**完成判定**（提交后弹窗消失即完成），题目容器由
`findQuizContainer` 自动探测（超星每题是独立的 `.TiMu`，两者不能混用）。

### 配置

```ts
interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  effort?: 'low' | 'none';  // low 准但慢，none 快但易误判
  batchSize?: number;       // 单次最多几题，超出分批（控总耗时）
}
```

### 底层能力（可单独复用）

| 导出 | 位置 | 用途 |
|---|---|---|
| `captureQuizShot` | `shot.ts` | 截取题目元素，返回 `QuizShot` |
| `toElementPoint` | `shot.ts` | 截图坐标 → 元素坐标 |
| `askQuizByVision` | `llm.ts` | 把截图批次送多模态模型，返回 `QuizAnswer[]` |

## 怎么接线

最小接法（在 `index.ts` 的测验分支里，替换或并联 `handleQuiz`）：

```ts
import { runAgent, quizGoal } from './agent/loop';

const v = this.opts.getVision();          // 多模态配置
if (!v?.apiKey || !v.baseUrl) { /* 没配则跳过 */ }

const r = await runAgent(
  { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, batchSize: 5 },
  this.opts.page,
  quizGoal('#pop'),                       // 或 undefined
  {
    log: (lv, m) => this.log(lv, m),
    checkpoint: () => this.ctl.throwIfStopped(),
    sleep: ms => this.ctl.sleep(ms),
  }
);
// r.ok / r.answered / r.reason
```

本地验证脚本（已被 `.gitignore` 排除，仅本机可用）里有可运行示例：
`scripts/local-verify-loop.mjs`、`scripts/local-verify-fill.mjs`、
`scripts/local-verify-e2e.mjs`（后者打真实视觉接口）。

## 接线时要先定的几件事

1. **与 `handleQuiz` 的关系**
   是「先试结构化、失败再降级到 agent」，还是「遇到特定界面直接上 agent」？
   前者更稳（省 token，结构化解析正确率更高），后者对未知界面更可靠。

2. **超时预算**
   `AgentGoal.budget = { maxSteps, maxMs }`，`quizGoal` 默认 240 秒。
   注意它和引擎整体的运行时长、以及 StallGuard 的关系。

3. **总开关**
   设置页的「AI 自动答题」（`agentEnabled`）目前门控的是现有答题链。
   接上 agent 后，同一个开关应继续作为总开关，不要让 agent 绕开它。

4. **成本**
   纯视觉路线单次调用量级见 `../visionSearcher.ts` 的用量日志
   （实测 5 题打包一次约 1.3K 输入 token）。agent 因为要逐题截图 + 坐标
   交互，调用次数会明显高于结构化路线，接线时要考虑是否需要限额。
