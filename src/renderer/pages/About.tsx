import { Alert, Descriptions, Tag, Typography } from 'antd';
import { useApp } from '../state';

export default function About() {
  const a = useApp();
  return (
    <div>
      <div className="cardish">
        <b>刷课助手 CourseHelper</b>
        <Descriptions column={1} size="small" style={{ marginTop: 10 }}>
          <Descriptions.Item label="版本">
            v{a.info?.version ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="内嵌浏览器">
            Electron WebContentsView + CDP（无需另装浏览器）
          </Descriptions.Item>
          <Descriptions.Item label="支持平台">
            <Tag color="blue">超星学习通</Tag>
            <Tag>更多平台规划中</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="授权状态">
            {a.licensed ? (
              <Tag color="success">已激活 · {a.licensed.codeId}</Tag>
            ) : (
              <Tag color="warning">未激活</Tag>
            )}
          </Descriptions.Item>
        </Descriptions>
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
          机器码：{a.machineId}
        </Typography.Text>
      </div>
    </div>
  );
}
