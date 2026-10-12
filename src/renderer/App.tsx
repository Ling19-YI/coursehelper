import React, { useEffect } from 'react';
import { App as AntApp, ConfigProvider, Menu, Tag, theme } from 'antd';
import {
  DashboardOutlined,
  FolderOpenOutlined,
  MonitorOutlined,
  SettingOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { AppProvider, useApp } from './state';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Monitor from './pages/Monitor';
import SettingsPage from './pages/Settings';
import About from './pages/About';
import type { TaskState } from '../shared/types';

/**
 * 左侧面板宽度由主进程决定（右侧学习通是叠在上面的 WebContentsView，
 * 两者的宽度必须同源）。这里把主进程算出的值写进 CSS 变量。
 *
 * 不要退回去用 `width: 46%` 之类的百分比：那会和主进程的
 * MIN_VIEW_WIDTH / MAX_PANEL_WIDTH 算成两套结果，窗口一宽右侧就盖住面板。
 */
function usePanelWidth() {
  useEffect(() => {
    return window.ch.onPanelWidth(px => {
      document.documentElement.style.setProperty('--panel-width', `${px}px`);
    });
  }, []);
}

export const STATE_META: Record<string, { color: string; text: string }> = {
  idle: { color: 'default', text: '空闲' },
  starting: { color: 'processing', text: '启动中' },
  login: { color: 'processing', text: '登录中' },
  listing: { color: 'processing', text: '读取课程' },
  running: { color: 'success', text: '运行中' },
  paused: { color: 'warning', text: '已暂停' },
  done: { color: 'success', text: '已完成' },
  error: { color: 'error', text: '出错' },
  stopped: { color: 'orange', text: '已停止' },
};

export const stateMeta = (s: TaskState) => STATE_META[s] ?? STATE_META.idle;

const PAGES: Record<string, React.ReactNode> = {
  dashboard: <Dashboard />,
  courses: <Courses />,
  monitor: <Monitor />,
  settings: <SettingsPage />,
  about: <About />,
};

function Shell() {
  const { page, setPage, engineState } = useApp();

  const meta = stateMeta(engineState);
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="brand">
          <span className="brand-mark">刷</span>
          刷课助手 CourseHelper
        </div>
        <div className="row">
          <Tag color="green">免费版</Tag>
          <Tag color={meta.color}>{meta.text}</Tag>
        </div>
      </div>
      <Menu
        theme="dark"
        mode="horizontal"
        selectedKeys={[page]}
        onClick={e => setPage(e.key)}
        style={{ background: 'transparent', borderInlineEnd: 'none' }}
        items={[
          { key: 'dashboard', icon: <DashboardOutlined />, label: '任务' },
          { key: 'courses', icon: <FolderOpenOutlined />, label: '课程' },
          { key: 'monitor', icon: <MonitorOutlined />, label: '日志' },
          { key: 'settings', icon: <SettingOutlined />, label: '设置' },
          { key: 'about', icon: <InfoCircleOutlined />, label: '关于' },
        ]}
      />
      <div className="page-body">{PAGES[page] ?? PAGES.dashboard}</div>
    </div>
  );
}

export default function App() {
  usePanelWidth();
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#3b82f6', borderRadius: 8, fontSize: 14 },
      }}
    >
      <AntApp>
        <AppProvider>
          <Shell />
        </AppProvider>
      </AntApp>
    </ConfigProvider>
  );
}
