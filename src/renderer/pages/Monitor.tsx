import { useEffect, useRef } from 'react';
import { Button, Tag } from 'antd';
import { ClearOutlined } from '@ant-design/icons';
import { useApp } from '../state';
import { fmtTime } from '../util';

const LEVEL_COLOR: Record<string, string> = {
  info: '#8b98ad',
  ok: '#34d399',
  warn: '#fbbf24',
  error: '#f87171',
};

export default function Monitor() {
  const a = useApp();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [a.logs]);

  return (
    <div>
      <div className="cardish row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="row">
          <Tag color="default">日志 {a.logs.length}</Tag>
          {a.video && (
            <span className="muted">
              {a.video.chapter} · {Math.floor(a.video.ct / 60)}:
              {String(Math.floor(a.video.ct % 60)).padStart(2, '0')}
            </span>
          )}
        </div>
        <Button size="small" icon={<ClearOutlined />} onClick={a.clearLogs}>
          清空
        </Button>
      </div>
      <div className="log-list" ref={listRef}>
        {a.logs.length === 0 ? (
          <span className="muted">暂无日志。启动任务后这里会实时滚动输出。</span>
        ) : (
          a.logs.map((l, i) => (
            <div className="log-line" key={`${l.ts}-${i}`}>
              <span className="log-ts">{fmtTime(l.ts)}</span>
              <span style={{ color: LEVEL_COLOR[l.level] ?? LEVEL_COLOR.info }}>
                {l.msg}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
