import { useState } from 'react';
import { Alert, App as AntApp, Button, Card, Descriptions, Input, Tag, Typography } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { useApp } from '../state';

export default function Activate({ standalone }: { standalone?: boolean }) {
  const { licensed, doActivate, machineId, info } = useApp();
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setErr('');
    try {
      const res = await doActivate(code.trim());
      if (res.ok) message.success('激活成功，欢迎使用');
      else setErr(res.message);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const body = licensed ? (
    <Descriptions column={1} size="small">
      <Descriptions.Item label="状态">
        <Tag color="success">已激活</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="授权编号">{licensed.codeId}</Descriptions.Item>
      <Descriptions.Item label="激活时间">
        {new Date(licensed.activatedAt).toLocaleString()}
      </Descriptions.Item>
      <Descriptions.Item label="机器码">
        <Typography.Text copyable code>{machineId}</Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="提示">
        授权与本机绑定；更换电脑需联系售后重新发放。
      </Descriptions.Item>
    </Descriptions>
  ) : (
    <div>
      <Input
        placeholder="粘贴激活码（CH1.xxxx.xxxx）"
        value={code}
        onChange={e => setCode(e.target.value)}
        onPressEnter={submit}
        spellCheck={false}
        size="large"
      />
      {err && (
        <Alert type="error" showIcon message={err} style={{ marginTop: 10 }} />
      )}
      <Button
        type="primary"
        size="large"
        block
        autoInsertSpace={false}
        style={{ marginTop: 12 }}
        loading={loading}
        onClick={submit}
      >
        激活
      </Button>
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 14 }}
        message="购买说明（占位）"
        description="付款后把下方机器码发给客服，即可获得激活码；正式版将接入官网自助下单。"
      />
      <div style={{ marginTop: 14 }}>
        <div className="muted">本机机器码（购买时提供）</div>
        <Typography.Text copyable code>
          {machineId || '...'}
        </Typography.Text>
      </div>
    </div>
  );

  const card = (
    <Card
      title={
        <span>
          <KeyOutlined /> 激活
        </span>
      }
      style={{ width: standalone ? 520 : '100%', maxWidth: 560 }}
    >
      {body}
    </Card>
  );

  return (
    <div style={standalone ? undefined : { marginBottom: 12 }}>
      {standalone ? (
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div className="brand" style={{ justifyContent: 'center', fontSize: 22 }}>
            <span className="brand-mark">刷</span>
            刷课助手 CourseHelper
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            {info?.version ? `v${info.version}` : ''}
          </div>
        </div>
      ) : null}
      {card}
    </div>
  );
}
