import React from 'react';
import { App as AntApp, ConfigProvider, Menu, Spin, Tag, theme } from 'antd';
import {
  DashboardOutlined,
  FolderOpenOutlined,
  MonitorOutlined,
  SettingOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { AppProvider, useApp } from './state';
import Activate from './pages/Activate';
import Dashboard from './pages/Dashboard';
import Courses from './pages/Courses';
import Monitor from './pages/Monitor';
import SettingsPage from './pages/Settings';
import About from './pages/About';
import type { TaskState } from '../shared/types';

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
  activate: <Activate />,
};

function Shell() {
  const { licensed, page, setPage, engineState } = useApp();

  if (licensed === undefined) {
    return (
      <div className="center-box">
        <Spin size="large" />
      </div>
    );
  }
  if (licensed === null) {
    return (
      <div className="center-box">
        <Activate standalone />
      </div>
    );
  }

  const meta = stateMeta(engineState);
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="brand">
          <span className="brand-mark">刷</span>
          刷课助手 CourseHelper
        </div>
        <div className="row">
          <Tag color={meta.color}>{meta.text}</Tag>
          <Tag
            color="blue"
            style={{ cursor: 'pointer' }}
            onClick={() => setPage('activate')}
          >
            已激活
          </Tag>
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
