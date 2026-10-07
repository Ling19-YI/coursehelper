import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Divider,
  Input,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from 'antd';
import { SaveOutlined, LogoutOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useApp } from '../state';

export default function Settings() {
  const a = useApp();
  const { message } = App.useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (a.settings) {
      setKey(a.settings.deepseekKey ?? '');
      setDataDir(a.settings.dataDir ?? '');
    }
    if (a.username) setUsername(a.username);
  }, [a.settings, a.username]);

  const save = async () => {
    setSaving(true);
    try {
      if (username.trim() && password) {
        await a.saveCredentials(username.trim(), password);
        setPassword('');
        message.success('账号已保存（密码已加密存储）');
      } else if (!username.trim()) {
        message.warning('请填写超星账号');
        setSaving(false);
        return;
      }
      await a.saveSettings({
        deepseekKey: key.trim(),
        dataDir: dataDir.trim(),
      });
      message.success('设置已保存');
    } catch (e) {
      message.error(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="cardish">
        <b>超星账号</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          仅保存在本机（系统加密），用于自动登录学习通。
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            placeholder="手机号 / 账号"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="off"
          />
          <Input.Password
            placeholder={a.username ? '已保存，留空则不修改密码' : '密码'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Space>
        {a.username && (
          <div className="row" style={{ marginTop: 10 }}>
            <Tag color="success">当前账号：{a.username}</Tag>
            <Popconfirm
              title="清除本机保存的账号密码？"
              onConfirm={async () => {
                await a.clearCredentials();
                setUsername('');
                message.success('已清除');
              }}
            >
              <Button size="small" danger icon={<LogoutOutlined />}>
                清除
              </Button>
            </Popconfirm>
          </div>
        )}
      </div>

      <div className="cardish">
        <b>DeepSeek API Key（选填）</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          用于自动回答章节测验；不填则遇到答题会跳过并记入日志。
        </div>
        <Input.Password
          placeholder="sk-..."
          value={key}
          onChange={e => setKey(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="cardish">
        <b>数据目录</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          保存各课程的断点进度（JSON）。任务运行中不可修改。
        </div>
        <Input
          value={dataDir}
          onChange={e => setDataDir(e.target.value)}
          prefix={<FolderOpenOutlined />}
        />
        <Button size="small" style={{ marginTop: 8 }} onClick={() => setDataDir(a.info?.dataDir ?? '')}>
          恢复默认
        </Button>
      </div>

      <Button type="primary" block icon={<SaveOutlined />} loading={saving} onClick={save}>
        保存设置
      </Button>

      {a.info?.legacy && (
        <>
          <Divider plain />
          <Alert
            type="info"
            showIcon
            message="已检测到旧版（命令行）数据"
            description="账号与各课程进度已自动迁移，可直接继续使用。"
          />
        </>
      )}

      <Divider plain />
      <Typography.Text className="muted" type="secondary">
        数据目录：{a.info?.dataDir}
      </Typography.Text>
    </div>
  );
}
