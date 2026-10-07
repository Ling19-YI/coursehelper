import { Alert, App as AntApp, Button, Progress, Space, Switch, Tag } from 'antd';
import {
  CaretRightOutlined,
  PauseOutlined,
  RocketOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useApp } from '../state';
import { stateMeta } from '../App';
import { fmtDur, RESULT_LABEL } from '../util';

const BUSY = ['starting', 'login', 'listing', 'running', 'paused'];

export default function Dashboard() {
  const a = useApp();
  const { message } = AntApp.useApp();
  const meta = stateMeta(a.engineState);
  const busy = BUSY.includes(a.engineState);
  const running = a.engineState === 'running';
  const paused = a.engineState === 'paused';

  const onStart = async () => {
    if (!a.selected.length) {
      message.warning('请先在「课程」页勾选要刷的课程');
      a.setPage('courses');
      return;
    }
    try {
      await a.start();
      a.setPage('monitor');
    } catch (e) {
      message.error(String((e as Error)?.message || e));
    }
  };

  return (
    <div>
      {!a.username && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="尚未配置超星账号"
          action={
            <Button size="small" onClick={() => a.setPage('settings')}>
              去设置
            </Button>
          }
        />
      )}

      <div className="cardish">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="muted">运行状态</div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
              <Tag color={meta.color}>{meta.text}</Tag>
            </div>
            {a.detail && <div className="muted">{a.detail}</div>}
          </div>
          <Space>
            {!busy && (
              <Button type="primary" icon={<RocketOutlined />} onClick={onStart}>
                开始刷课
              </Button>
            )}
            {running && (
              <Button autoInsertSpace={false} icon={<PauseOutlined />} onClick={a.pause}>
                暂停
              </Button>
            )}
            {paused && (
              <Button autoInsertSpace={false} icon={<CaretRightOutlined />} onClick={a.resumeRun}>
                继续
              </Button>
            )}
            {busy && (
              <Button danger autoInsertSpace={false} icon={<StopOutlined />} onClick={a.stop}>
                停止
              </Button>
            )}
          </Space>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <span className="muted">断点续跑</span>
          <Switch
            size="small"
            checked={a.resume}
            onChange={a.setResume}
            checkedChildren="开"
            unCheckedChildren="关"
          />
          <span className="muted">已选 {a.selected.length} 门课程</span>
          {a.resume && a.selected.length > 0 && (
            <span className="muted">· 从上次未完成的章节继续</span>
          )}
        </div>
      </div>

      {a.video && running && (
        <div className="cardish">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b
              style={{
                maxWidth: '68%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {a.video.chapter}
            </b>
            <Tag color={a.video.paused ? 'warning' : 'success'}>
              {a.video.paused ? '暂停中 · 守护重试' : '播放中'}
            </Tag>
          </div>
          <Progress
            percent={a.video.d > 0 ? Math.min(100, (a.video.ct / a.video.d) * 100) : 0}
            size="small"
            format={() => `${fmtDur(a.video!.ct)} / ${fmtDur(a.video!.d)}`}
          />
        </div>
      )}

      {a.chapter && (running || paused) && (
        <div className="cardish">
          <div className="muted">当前章节</div>
          <div style={{ marginTop: 4 }}>
            {a.chapter.index + 1} / {a.chapter.total} · {a.chapter.name}
          </div>
          <div style={{ marginTop: 8 }}>
            <Tag
              color={
                RESULT_LABEL[a.chapter.result]?.color ??
                RESULT_LABEL.error.color
              }
            >
              {RESULT_LABEL[a.chapter.result]?.text ?? a.chapter.result}
            </Tag>
          </div>
        </div>
      )}

      <div className="cardish row" style={{ gap: 28 }}>
        <div>
          <div className="muted">本次完成章节</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{a.summary.completed}</div>
        </div>
        <div>
          <div className="muted">跳过（已完成/无需处理）</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{a.summary.skipped}</div>
        </div>
        <div>
          <div className="muted">已选课程</div>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{a.selected.length}</div>
        </div>
      </div>
    </div>
  );
}
