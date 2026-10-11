/**
 * 题目与答案通道的类型契约。
 *
 * 单独成文件是为了断开 quiz.ts ↔ searcher.ts 的循环依赖：
 * quiz.ts 依赖 searcher（要跑答案链），searcher 也依赖这些类型和 askAI。
 */

export type QType = 'single' | 'multi' | 'judge' | 'fill' | 'unknown';

export interface QuizOption {
  label: string;
  text: string;
}

export interface QuizQuestion {
  index: number;
  stem: string;
  type: QType;
  options: QuizOption[];
  hasInput: boolean;
  /**
   * 页面自己已经透露的答案（已勾选的选项 / 带正确答案 class 的选项）。
   *
   * 这是答案链的第一优先级：平台把答案标在 DOM 上时直接拿来用，
   * 既准确又省掉一次模型调用。解析不到就是 undefined。
   */
  revealed?: string;
  /**
   * 题干/选项被超星的字体加密（.font-cxsecret）糊掉了。
   *
   * 实测：这类题 innerText 取出来是「行列嘫」「鰢嘪嘬一嘭」这种形近/生僻字，
   * 原样发给模型只会得到乱码答案，还���把乱码沉淀进本地题库污染后续命中。
   * 识别为加密题后 stem 置空，由上层转走截图识别。
   */
  encrypted?: boolean;
}

/** AI 问答通道：任意 OpenAI 兼容的 /chat/completions 端点 */
export interface AnswerChannel {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 仅用于日志展示，例如「多模态」或「DeepSeek」 */
  label: string;
}
