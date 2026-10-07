import { useEffect } from 'react';
import { App, Button, Empty, Space, Table, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApp } from '../state';
import type { Course } from '../../shared/types';

export default function Courses() {
  const a = useApp();
  const { message } = App.useApp();

  useEffect(() => {
    if (!a.courses && a.username && a.licensed) {
      a.refreshCourses().catch(e =>
        message.error(String((e as Error)?.message || e))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const storedMap = new Map(a.storedProg.map(p => [p.courseId, p]));

  const columns = [
    {
      title: '课程',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string) => <span title={v}>{v}</span>,
    },
    {
      title: '进度',
      key: 'progress',
      width: 130,
      render: (_: unknown, c: Course) => {
        const p = a.platformProg[c.courseId];
        const st = storedMap.get(c.courseId);
        if (p) {
          const pct = p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
          const color = pct >= 100 ? 'success' : 'processing';
          return (
            <Tag color={color}>
              {p.completed}/{p.total} 任务点
            </Tag>
          );
        }
        if (st) return <Tag>{st.completedChapters.length} 章已标记</Tag>;
        return <span className="muted">—</span>;
      },
    },
    {
      title: '上次完成',
      key: 'last',
      ellipsis: true,
      width: 160,
      render: (_: unknown, c: Course) => {
        const st = storedMap.get(c.courseId);
        const last = st?.lastChapter ?? '';
        // 存储的是 onclick 字符串时不展示原始代码
        if (!last || /[('"]/.test(last)) return <span className="muted">—</span>;
        return (
          <span className="muted" title={last}>
            {last}
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <div className="cardish row" style={{ justifyContent: 'space-between' }}>
        <Space>
          <span className="muted">已选 {a.selected.length} 门</span>
          <Button
            size="small"
            autoInsertSpace={false}
            disabled={!a.courses?.length}
            onClick={() => a.setSelected(a.courses!.map(c => c.courseId))}
          >
            全选
          </Button>
          <Button
            size="small"
            autoInsertSpace={false}
            disabled={!a.selected.length}
            onClick={() => a.setSelected([])}
          >
            清空
          </Button>
        </Space>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={a.loadingCourses}
          onClick={() =>
            a.refreshCourses().catch(e =>
              message.error(String((e as Error)?.message || e))
            )
          }
        >
          刷新课程
        </Button>
      </div>

      {!a.courses?.length ? (
        <Empty
          description={
            a.loadingCourses
              ? '正在读取课程列表…'
              : '暂无课程，点击右上角「刷新课程」'
          }
          style={{ paddingTop: 48 }}
        />
      ) : (
        <Table<Course>
          rowKey="courseId"
          size="small"
          columns={columns}
          dataSource={a.courses}
          pagination={false}
          scroll={{ y: 'calc(100vh - 260px)' }}
          rowSelection={{
            selectedRowKeys: a.selected,
            onChange: keys => a.setSelected(keys as string[]),
            preserveSelectedRowKeys: true,
          }}
        />
      )}
    </div>
  );
}
