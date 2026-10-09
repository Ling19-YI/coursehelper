import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Divider,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { Switch, Tooltip } from 'antd';
import { SaveOutlined, LogoutOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useApp } from '../state';

export default function Settings() {
  const a = useApp();
  const { message } = App.useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [speed, setSpeed] = useState<number>(1);
  const [agentOn, setAgentOn] = useState(false);
  const [visionKey, setVisionKey] = useState('');
  const [visionInfo, setVisionInfo] = useState<{ configured: boolean; hint: string }>({
    configured: false,
    hint: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (a.settings) {
      setKey(a.settings.deepseekKey ?? '');
      setDataDir(a.settings.dataDir ?? '');
      setSpeed(Number(a.settings.videoSpeed) || 1);
      setAgentOn(!!a.settings.agentEnabled);
    }
    if (a.username) setUsername(a.username);
    window.ch.getVision().then(setVisionInfo).catch(() => {});
  }, [a.settings, a.username]);

  const save = async () => {
    setSaving(true);
    try {
      if (agentOn && !visionInfo.configured && !visionKey.trim()) {
        message.warning('AI 答题需要先填写多模态 API Key');
        setSaving(false);
        return;
      }
      if (username.trim() && password) {
        await a.saveCredentials(username.trim(), password);
        setPassword('');
        message.success('账号已保存（密码已加密存储）');
      } else if (!username.trim()) {
        message.warning('请填写超星账号');
        setSaving(false);
        return;
      }
      if (visionKey.trim()) {
        await window.ch.setVision(visionKey.trim());
        setVisionKey('');
      }
      await a.saveSettings({
        deepseekKey: key.trim(),
        dataDir: dataDir.trim(),
        videoSpeed: speed,
        agentEnabled: agentOn,
      });
      window.ch.getVision().then(setVisionInfo).catch(() => {});
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
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <b>AI 自动答题</b>
          <Tooltip
            title={
              visionInfo.configured
                ? '开启后遇到测验或随堂弹窗会自动答题'
                : '需先在下方填写多模态 API Key'
            }
          >
            <Switch checked={agentOn} onChange={setAgentOn} disabled={!visionInfo.configured} />
          </Tooltip>
        </div>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          总开关。关闭后遇到题目会跳过并记入日志，不影响视频播放与文档任务。
          {agentOn && (
            <div style={{ marginTop: 6 }}>
              <Tag color="processing">已开启</Tag>
            </div>
          )}
        </div>
      </div>

      <div className="cardish">
        <b>多模态 API Key</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          用于看图答题。仅保存在本机（系统加密），不会上传或写入配置文件。
        </div>
        <Input.Password
          placeholder={visionInfo.configured ? `已保存 ${visionInfo.hint}，留空则不修改` : 'sk-...'}
          value={visionKey}
          onChange={e => setVisionKey(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="cardish">
        <b>DeepSeek API Key（选填）</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          仅用于纯文本场景的章节测验；AI 自动答题走上方多模态通道。
        </div>
        <Input.Password
          placeholder="sk-..."
          value={key}
          onChange={e => setKey(e.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="cardish">
        <b>视频倍速</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          只影响课程视频，不影响文档与测验。个别视频平台会强制 1x，届时会自动改回并在日志提示。
        </div>
        <Select
          value={speed}
          onChange={v => setSpeed(v)}
          style={{ width: '100%' }}
          options={[
            { value: 1, label: '1x（默认，最稳）' },
            { value: 1.25, label: '1.25x（推荐）' },
            { value: 1.5, label: '1.5x（更快）' },
            { value: 2, label: '2x（最快，进度上报可能受影响）' },
          ]}
        />
        {speed > 1 && (
          <div style={{ marginTop: 10 }}>
            <Alert
              type="warning"
              showIcon
              message="倍速可能影响平台进度上报，建议先小范围试一节课，确认平台已记录进度后再全量使用。"
            />
          </div>
        )}
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
