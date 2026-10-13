/**
 * 清洗用户填写的 OpenAI 兼容接口地址（visionBaseUrl）。
 *
 * 软件调用时会在地址后面自动拼 /chat/completions，但真实用户里高频出现
 * 把服务商文档里的「完整接口路径」整段粘进设置（例如
 * https://open.bigmodel.cn/api/paas/v4/chat/completions），拼出来变成
 * …/chat/completions/chat/completions，服务端回一句
 * 「No static resource …」的 400——用户完全看不出是自己地址填错了
 * （2026-10-13 两位用户反馈同款）。
 *
 * 在保存（settings:set）和调用（visionChannel / getVision）两侧都过一遍：
 *  - 新用户保存时就把错误纠正掉；
 *  - 老用户已经存盘的脏地址，不用重新保存也能被纠正。
 *
 * 兼容两类合法写法：服务商文档给「Base URL」（以 /v1 /v4 等结尾）直接用；
 * 给「完整接口路径」（以 /chat/completions 结尾）去掉尾巴后等价。
 */
export function normalizeBaseUrl(raw: string): string {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  // 有人会连文档里的引号一起复制
  url = url.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  // 去掉整段粘贴带来的 /chat/completions 结尾（大小写不敏感）
  url = url.replace(/\/chat\/completions\/?$/i, '');
  // 统一去掉尾斜杠（原先 fetch 处只做了这一步）
  return url.replace(/\/+$/, '');
}
