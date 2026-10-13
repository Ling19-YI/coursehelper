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
import { normalizeBaseUrl } from '../../shared/baseUrl';

export default function Settings() {
  const a = useApp();
  const { message } = App.useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [speed, setSpeed] = useState<number>(1);
  const [agentOn, setAgentOn] = useState(false);
  const [coverRate, setCoverRate] = useState<number>(0.8);
  const [popupOn, setPopupOn] = useState(false);
  const [pauseOnVerify, setPauseOnVerify] = useState(false);
  const [muted, setMuted] = useState(true);
  const [visionKey, setVisionKey] = useState('');
  // 不预置地址：公开版本不该把用户导到某个特定服务商（尤其是别人付费的）
  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [visionModel, setVisionModel] = useState('mimo-v2.5');
  const [visionInfo, setVisionInfo] = useState<{ configured: boolean; hint: string }>({
    configured: false,
    hint: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (a.settings) {
      setDataDir(a.settings.dataDir ?? '');
      setSpeed(Number(a.settings.videoSpeed) || 1);
      setVisionBaseUrl(a.settings.visionBaseUrl || '');
      setVisionModel(a.settings.visionModel || 'mimo-v2.5');
      setAgentOn(!!a.settings.agentEnabled);
      setCoverRate(
        a.settings.submitCoverRate === undefined ? 0.8 : Number(a.settings.submitCoverRate)
      );
      setPopupOn(!!a.settings.answerPopup);
      setPauseOnVerify(!!a.settings.autoPauseOnVerify);
      setMuted(a.settings.muted !== false);
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
      // 有密钥但没地址 = 引擎侧一定算出空通道（answerChannel 要求两者都有）。
      // 以前 vision:get 只看 key 就报「已配置」，用户存着 key 空着地址，
      // 答题时日志只剩「未配置 AI 接口」，没人提示该去填地址。
      const hasKey = !!visionKey.trim() || visionInfo.configured;
      if (hasKey && !visionBaseUrl.trim()) {
        message.warning('已填写 API Key 但接口地址为空，AI 答题不会被调用');
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
      // 保存侧纠正：允许用户直接粘贴服务商文档里的完整接口路径
      // （…/chat/completions），存盘前去掉尾巴；输入框同步显示纠正后的值。
      const cleanedBaseUrl = normalizeBaseUrl(visionBaseUrl);
      setVisionBaseUrl(cleanedBaseUrl);
      await a.saveSettings({
        dataDir: dataDir.trim(),
        videoSpeed: speed,
        agentEnabled: agentOn,
        submitCoverRate: coverRate,
        answerPopup: popupOn,
        autoPauseOnVerify: pauseOnVerify,
        muted,
        visionBaseUrl: cleanedBaseUrl,
        visionModel: visionModel.trim() || 'mimo-v2.5',
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
          答题与看图解题都用它（OpenAI 兼容接口）。仅保存在本机（系统加密），不会上传或写入配置文件。
        </div>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.Password
            placeholder={visionInfo.configured ? `已保存 ${visionInfo.hint}，留空则不修改` : 'sk-...'}
            value={visionKey}
            onChange={e => setVisionKey(e.target.value)}
            autoComplete="off"
          />
          <Input
            placeholder="接口地址，如 https://api.example.com/v1"
            value={visionBaseUrl}
            onChange={e => setVisionBaseUrl(e.target.value)}
            autoComplete="off"
          />
          <div className="muted" style={{ fontSize: 12 }}>
            填服务商文档给的 Base URL（一般以 /v1、/v4 结尾）。直接粘贴完整接口路径（以
            /chat/completions 结尾）也可以，保存时会自动纠正。
          </div>
          {(visionInfo.configured || visionKey.trim()) && !visionBaseUrl.trim() && (
            <div style={{ color: '#faad14', fontSize: 12 }}>
              ⚠ 接口地址为空：密钥已保存但 AI 答题不会被调用（文本答题和看图答题都用这个地址）
            </div>
          )}
          <Input
            placeholder="模型名（需支持图片输入）"
            value={visionModel}
            onChange={e => setVisionModel(e.target.value)}
            autoComplete="off"
            title="任何支持 OpenAI 兼容 chat/completions + image_url 的多模态模型都可以，如通义 qwen3-vl-plus、glm-4.6v、mimo-v2.5 等；纯文本模型吃不了图"
          />
        </Space>
        <div className="muted" style={{ marginTop: 8 }}>
          接口需兼容 OpenAI 格式（/chat/completions）。单次会逐题截图分批发送，题越多耗时越长。
        </div>
      </div>

      <div className="cardish">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <b>遇到人脸识别 / 验证码时暂停</b>
          <Tooltip title="开启后，检测到人脸识别、验证码或安全验证弹窗会停下手上的模拟动作等人工处理；关闭则照常运行，真卡住时会被判为停滞并跳过该节。">
            <Switch checked={pauseOnVerify} onChange={setPauseOnVerify} />
          </Tooltip>
        </div>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          默认<strong>关闭</strong>。这类弹窗的识别很容易误判——课程正文里本来就会出现「人脸识别」
          「验证码」这些词，一旦误判整轮刷课就停在那里等人，而日志里看不出所以然。
          关闭后引擎照常跑，真遇到验证码会因视频停滞被判为卡住并跳过，不会无限等。
        </div>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          手机扫码不受此项影响：始终会暂停。引擎一旦继续动作，二维码会被平台判定为环境变化
          而反复刷新，人根本扫不上。
        </div>
      </div>

      <div className="cardish">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <b>视频中的随堂题弹窗</b>
          <Tooltip title="关闭时遇到弹窗会等 StallGuard 判定卡住后在日志提示；开启后自动答题并继续播放。">
            {/* 总开关（AI 自动答题）关掉时，这个子开关没有意义 */}
            <Switch
              checked={popupOn}
              onChange={setPopupOn}
              disabled={!visionInfo.configured || !agentOn}
            />
          </Tooltip>
        </div>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          默认<strong>关闭</strong>。弹窗出现时视频通常已经暂停，此时自动介入会让「真的卡住」和
          「该答题了」难以区分，误操作会打断正常播放。需要自动处理时再打开。
        </div>
        {popupOn && (
          <Alert
            type="warning"
            showIcon
            message="已开启随堂弹窗自动答题"
            description="仅在检测到答题弹窗时介入，处理完立即恢复播放；答不全按下面的覆盖率下限处理，不会硬交。"
          />
        )}
      </div>

      <div className="cardish">
        <b>交卷覆盖率下限</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          自动答题算出的答案低于该比例时<strong>不交卷</strong>，只把已答的部分留在页面上等人工核对。
          搜不全还硬交，等于把确定的错题一起交上去。
        </div>
        <Select
          value={coverRate}
          onChange={v => setCoverRate(v)}
          style={{ width: '100%' }}
          options={[
            { value: 0, label: '关闭（搜多少交多少）' },
            { value: 0.5, label: '50%' },
            { value: 0.8, label: '80%（推荐）' },
            { value: 0.9, label: '90%' },
            { value: 1, label: '100%（必须全有才交）' },
          ]}
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
        <b>视频静音</b>
        <div className="muted" style={{ margin: '6px 0 10px' }}>
          默认静音。刷课时无需出声，也避免多开任务时声音叠加。
          关闭后视频会正常播放声音。
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Switch checked={muted} onChange={setMuted} />
          <span style={{ fontSize: 13 }}>
            {muted ? '静音播放' : '正常播放（有声）'}
          </span>
        </div>
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
