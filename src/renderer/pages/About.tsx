import { Alert, Button, Descriptions, Progress, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { CloudDownloadOutlined } from '@ant-design/icons';
import { useApp } from '../state';
import type { UpdateState } from '../../shared/api';
import donateQr from '../donate.jpg';

const fmtSize = (b: number) => (b > 0 ? `${(b / 1024 / 1024).toFixed(1)} MB` : '—');

export default function About() {
  const a = useApp();
  const [up, setUp] = useState<UpdateState | null>(null);

  useEffect(() => {
    window.ch.getUpdateState().then(setUp).catch(() => {});
    return window.ch.onUpdateEvent(s => setUp(s));
  }, []);

  const check = async () => {
    setUp(s => (s ? { ...s, checking: true, message: '正在检查更新…' } : s));
    const s = await window.ch.checkUpdate().catch(() => null);
    if (s) setUp(s);
  };

  const download = async () => {
    const s = await window.ch.downloadUpdate().catch(() => null);
    if (s) setUp(s);
  };

  const install = async () => {
    await window.ch.installUpdate();
  };

  const downloaded = (up?.percent ?? 0) >= 100 && !up?.downloading;
  const hasNew = !!up?.available;

  return (
    <div>
      <div className="cardish">
        <b>软件更新</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          新版本发布后，打开软件即可在线更新，不需要重新下载安装包。
        </div>

        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Button onClick={check} loading={up?.checking} icon={<CloudDownloadOutlined />}>
              检查更新
            </Button>
            {hasNew && !downloaded && (
              <Button type="primary" onClick={download} loading={up?.downloading}>
                下载新版本
              </Button>
            )}
            {downloaded && (
              <Button type="primary" onClick={install}>
                重启并安装
              </Button>
            )}
          </Space>

          {up?.downloading && (
            <div style={{ marginTop: 4 }}>
              <Progress percent={Math.round(up.percent)} size="small" />
              <div className="muted" style={{ marginTop: 4 }}>
                已下载 {fmtSize(up.transferred)} / {fmtSize(up.total)}
                {up.speed > 0 && ` · ${fmtSize(up.speed)}/s`}
              </div>
            </div>
          )}

          {hasNew && !up?.downloading && !downloaded && (
            <Alert
              type="success"
              showIcon
              message={`发现新版本 v${up?.version}`}
              description={
                up?.notes ? (
                  <div style={{ maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                    {up.notes}
                  </div>
                ) : undefined
              }
            />
          )}

          {downloaded && (
            <Alert
              type="success"
              showIcon
              message={`v${up?.version} 已下载完成`}
              description="点击上方「重启并安装」即可完成更新。"
            />
          )}

          {up?.message && !up?.downloading && <div className="muted">{up.message}</div>}
        </Space>
      </div>
      <div className="cardish">
        <b>刷课助手 CourseHelper</b>
        <Descriptions column={1} size="small" style={{ marginTop: 10 }}>
          <Descriptions.Item label="版本">v{a.info?.version ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="价格">
            <Tag color="green">完全免费 · 无需激活码</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="内嵌浏览器">
            Electron WebContentsView + CDP（无需另装浏览器）
          </Descriptions.Item>
          <Descriptions.Item label="支持平台">
            <Tag color="blue">超星学习通</Tag>
            <Tag>更多平台规划中</Tag>
          </Descriptions.Item>
        </Descriptions>
      </div>

      <div className="cardish" style={{ textAlign: 'center' }}>
        <b style={{ fontSize: 18 }}>支持作者（自愿）</b>
        <div className="muted" style={{ margin: '8px 0 14px' }}>
          这个工具完全免费、不收任何费用。如果你觉得有用，可以请作者喝杯奶茶❤
        </div>
        <img
          src={donateQr}
          alt="微信收款码"
          style={{
            height: 220,
            borderRadius: 10,
            border: '1px solid rgba(148,163,184,.25)',
          }}
        />
        <div className="muted" style={{ marginTop: 10 }}>
          长按 / 扫码自愿支持，不支持也完全不影响使用
        </div>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="使用须知"
        description={
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>本工具仅供学习与技术研究，请遵守所在学校与平台的使用规则，风险自负。</li>
            <li>播放速度遵循平台默认倍速，不修改倍速以避免平台风控。</li>
            <li>遇到卡顿时会自动重试；连续失败请到「日志」页查看原因。</li>
          </ul>
        }
      />

      <Alert
        type="info"
        showIcon
        message="Windows SmartScreen 提示"
        description="正式发布暂未购买代码签名证书，首次运行可能提示“已保护你的电脑”。点击「更多信息 → 仍要运行」即可，下载页会附带图文说明。"
      />

      <div style={{ marginTop: 14 }}>
        <Typography.Text className="muted" type="secondary">
          反馈问题或功能建议，欢迎在 GitHub 仓库提 Issue。
        </Typography.Text>
      </div>
    </div>
  );
}