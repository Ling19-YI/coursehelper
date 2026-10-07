export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

export const RESULT_LABEL: Record<string, { text: string; color: string }> = {
  completed: { text: '已完成', color: 'success' },
  doc_done: { text: '文档完成', color: 'success' },
  no_video: { text: '无视频', color: 'default' },
  stuck: { text: '播放卡住', color: 'error' },
  unexpected: { text: '页面异常', color: 'error' },
  quiz_ok: { text: '答题完成', color: 'success' },
  quiz_skip: { text: '答题跳过', color: 'default' },
  error: { text: '出错', color: 'error' },
  skipped: { text: '已跳过', color: 'default' },
};
