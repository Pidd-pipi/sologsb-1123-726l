import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { ImportOutlined, ThunderboltOutlined, SwapOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import { WAYPOINT_ACTIONS, parseWaypointText, type Waypoint, type WaypointAction } from '../types/waypoint';
import { calcGsd, groundCoverage, pointInPolygon } from '../utils/geoCalc';

type Columns = NonNullable<TableProps<Waypoint>['columns']>;

/** /missions/:id/waypoints 航点明细：经纬度粘贴导入、批量改高度、顺序拖拽、单点视场预览 */
export default function WaypointTable() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addMany = useWaypointStore((s) => s.addMany);
  const update = useWaypointStore((s) => s.update);
  const shiftMany = useWaypointStore((s) => s.shiftMany);
  const move = useWaypointStore((s) => s.move);
  const reorder = useWaypointStore((s) => s.reorder);
  const remove = useWaypointStore((s) => s.remove);
  const clearMission = useWaypointStore((s) => s.removeByMission);

  const mission = missions.find((m) => m.id === id);
  const rows = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  const [pasteText, setPasteText] = useState('');
  const [batchAltitude, setBatchAltitude] = useState(120);
  const [previewId, setPreviewId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [shiftEast, setShiftEast] = useState(0);
  const [shiftNorth, setShiftNorth] = useState(0);
  const [shiftViolations, setShiftViolations] = useState<Waypoint[]>([]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 导入后即落在测区外（或平移后越界）的航点；移回界内前不允许保存航线参数 */
  const outsideRows = useMemo(() => {
    if (!mission || mission.areaPolygon.length < 3) return [];
    return rows.filter((w) => !pointInPolygon([w.lng, w.lat], mission.areaPolygon));
  }, [rows, mission]);
  const outsideIds = useMemo(() => new Set(outsideRows.map((w) => w.id)), [outsideRows]);

  // 航点被删除或清空后，同步清理勾选状态，避免对已不存在的点执行平移
  useEffect(() => {
    setSelectedIds((prev) => {
      const alive = new Set(rows.map((w) => w.id));
      const next = prev.filter((id) => alive.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [rows]);

  const preview = rows.find((w) => w.id === previewId) ?? rows[0];
  const metrics = useRouteMetrics(id, { ...DEFAULT_ROUTE_PARAMS, altitude: preview?.altitude ?? 120 });

  const importPaste = async () => {
    const parsed = parseWaypointText(pasteText);
    if (parsed.length === 0) {
      setError('未解析到有效经纬度：每行应为「经度,纬度[,航高]」');
      return;
    }
    const startSeq = rows.length === 0 ? 1 : Math.max(...rows.map((w) => w.seq)) + 1;
    await addMany(
      parsed.map((p, index) => ({
        missionId: id,
        seq: startSeq + index,
        lng: Number(p.lng.toFixed(6)),
        lat: Number(p.lat.toFixed(6)),
        altitude: p.altitude ?? batchAltitude,
        speed: 8,
        heading: 90,
        gimbalPitch: -90,
        action: '拍照' as WaypointAction,
        hoverSec: 0,
      })),
    );
    setError('');
    setToast(`已导入 ${parsed.length} 个航点（序号 ${startSeq} 起）`);
    setPasteText('');
  };

  const applyBatchAltitude = async () => {
    for (const w of rows) {
      await update(w.id, { altitude: batchAltitude });
    }
    setToast(`已把 ${rows.length} 个航点的高度统一改为 ${batchAltitude} m`);
  };

  const applyShift = async () => {
    if (!mission || selectedIds.length === 0) return;
    const result = await shiftMany(selectedIds, shiftEast, shiftNorth, mission.areaPolygon);
    if (!result.applied) {
      setShiftViolations(result.violations);
      setError('平移未执行：以下航点移动后会越过测区边界，已整体取消（未勾选的点本就留在原位）。');
      setToast('');
      return;
    }
    setShiftViolations([]);
    setError('');
    const parts = [result.eastM !== 0 ? `向东 ${result.eastM} m` : '', result.northM !== 0 ? `向北 ${result.northM} m` : ''].filter(Boolean);
    setToast(`已整体平移 ${result.moved.length} 个航点（${parts.join('、') || '未移动'}），其余航点保持原位`);
  };

  const columns: Columns = [
    { title: '序号', dataIndex: 'seq', width: 70, render: (v: number) => `#${v}` },
    { title: '经度', dataIndex: 'lng', width: 120, render: (v: number) => v.toFixed(6) },
    { title: '纬度', dataIndex: 'lat', width: 120, render: (v: number) => v.toFixed(6) },
    {
      title: '测区位置',
      width: 100,
      filters: [
        { text: '界外航点', value: 'outside' },
        { text: '界内航点', value: 'inside' },
      ],
      onFilter: (value, row) => (value === 'outside' ? outsideIds.has(row.id) : !outsideIds.has(row.id)),
      render: (_: unknown, row: Waypoint) =>
        outsideIds.has(row.id) ? <Tag color="error">界外</Tag> : <Tag color="success">界内</Tag>,
    },
    {
      title: '相对航高 m',
      width: 140,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={20} max={600} value={row.altitude} onChange={(v) => update(row.id, { altitude: Number(v ?? 0) })} />
      ),
    },
    {
      title: '航速 m/s',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={1} max={25} step={0.5} value={row.speed} onChange={(v) => update(row.id, { speed: Number(v ?? 0) })} />
      ),
    },
    {
      title: '航向 °',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={0} max={360} value={row.heading} onChange={(v) => update(row.id, { heading: Number(v ?? 0) })} />
      ),
    },
    {
      title: '云台俯仰 °',
      width: 130,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={-90} max={30} value={row.gimbalPitch} onChange={(v) => update(row.id, { gimbalPitch: Number(v ?? 0) })} />
      ),
    },
    {
      title: '动作',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <Select
          size="small"
          style={{ width: 100 }}
          value={row.action}
          onChange={(v) => update(row.id, { action: v as WaypointAction })}
          options={WAYPOINT_ACTIONS.map((a) => ({ value: a, label: a }))}
        />
      ),
    },
    {
      title: '悬停 s',
      width: 110,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={0} max={300} value={row.hoverSec} onChange={(v) => update(row.id, { hoverSec: Number(v ?? 0) })} />
      ),
    },
    {
      title: '视场（宽×航向）m',
      width: 170,
      render: (_: unknown, row: Waypoint) =>
        mission
          ? `${groundCoverage(mission.sensorWidth, row.altitude, mission.focalLength)} × ${groundCoverage(
              mission.sensorHeight,
              row.altitude,
              mission.focalLength,
            )}`
          : '—',
    },
    {
      title: '单点 GSD cm/px',
      width: 140,
      render: (_: unknown, row: Waypoint) =>
        mission ? calcGsd(mission.pixelSize, row.altitude, mission.focalLength) : '—',
    },
    {
      title: '顺序',
      width: 210,
      render: (_: unknown, row: Waypoint, index: number) => (
        <Space size={4}>
          <Button size="small" disabled={index === 0} onClick={() => move(row.id, 'up')}>
            上移
          </Button>
          <Button size="small" disabled={index === rows.length - 1} onClick={() => move(row.id, 'down')}>
            下移
          </Button>
          <span
            draggable
            title="拖拽到目标行可交换顺序"
            style={{ cursor: 'grab', color: '#97a0ad' }}
            onDragStart={() => setPreviewId(row.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => reorder(row.id, previewId)}
          >
            ⣿
          </span>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 150,
      render: (_: unknown, row: Waypoint) => (
        <Space size={4}>
          <Button size="small" onClick={() => setPreviewId(row.id)}>
            预览视场
          </Button>
          <Button size="small" danger onClick={() => remove(row.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航点明细 · {mission.missionNo}
        </Typography.Title>
        <Tag color="green">航点 {rows.length} 个</Tag>
        {outsideRows.length > 0 ? <Tag color="error">界外 {outsideRows.length} 个 · 禁止保存航线参数</Tag> : null}
        <Tag>传感器 {mission.sensorWidth}×{mission.sensorHeight} mm / f{mission.focalLength} mm</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button danger size="small" onClick={() => clearMission(mission.id)}>
          清空本任务航点
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {outsideRows.length > 0 ? (
        <Alert
          data-testid="outside-waypoint-alert"
          type="error"
          showIcon
          message={`有 ${outsideRows.length} 个航点在测区边界外，移回界内前不能保存航线参数`}
          description={
            <Space size={4} wrap>
              {outsideRows.map((w) => (
                <Tag key={w.id} color="error">
                  #{w.seq}（{w.lng.toFixed(6)}, {w.lat.toFixed(6)}）
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}
      {shiftViolations.length > 0 ? (
        <Alert
          data-testid="shift-violation-alert"
          type="warning"
          showIcon
          message="平移后越界的航点"
          description={
            <Space size={4} wrap>
              {shiftViolations.map((w) => (
                <Tag key={w.id} color="warning">
                  #{w.seq}（{w.lng.toFixed(6)}, {w.lat.toFixed(6)}）
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      <Row gutter={14}>
        <Col span={10}>
          <Card size="small" title="经纬度粘贴导入">
            <Input.TextArea
              rows={6}
              placeholder={'每行一个点，例如：\n116.391200,39.907500\n116.393000,39.906800,150'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <Space style={{ marginTop: 8 }}>
              <Button type="primary" icon={<ImportOutlined />} onClick={importPaste}>
                导入航点
              </Button>
              <Button onClick={() => setPasteText('')}>清空文本</Button>
            </Space>
          </Card>
          <Card size="small" title="批量修改高度" style={{ marginTop: 12 }}>
            <Space>
              <InputNumber min={20} max={600} step={5} value={batchAltitude} onChange={(v) => setBatchAltitude(Number(v ?? 0))} />
              <span>m</span>
              <Button icon={<ThunderboltOutlined />} onClick={applyBatchAltitude} disabled={rows.length === 0}>
                应用到全部航点
              </Button>
            </Space>
          </Card>
          <Card
            size="small"
            title="测区内整体平移"
            style={{ marginTop: 12 }}
            extra={<Tag color={selectedIds.length > 0 ? 'blue' : 'default'}>已勾选 {selectedIds.length} / {rows.length}</Tag>}
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                在下方表格勾选航点，整体向东、向北平移（相对队形不变）；未勾选的点留在原位。任一点平移后越过测区边界时整批不执行。
              </Typography.Text>
              <Space wrap>
                <span>向东</span>
                <InputNumber
                  addonAfter="m"
                  value={shiftEast}
                  step={1}
                  style={{ width: 130 }}
                  onChange={(v) => setShiftEast(Number(v ?? 0))}
                />
                <span>向北</span>
                <InputNumber
                  addonAfter="m"
                  value={shiftNorth}
                  step={1}
                  style={{ width: 130 }}
                  onChange={(v) => setShiftNorth(Number(v ?? 0))}
                />
              </Space>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<SwapOutlined />}
                  onClick={applyShift}
                  disabled={selectedIds.length === 0 || (shiftEast === 0 && shiftNorth === 0)}
                >
                  平移已勾选航点
                </Button>
                <Button
                  onClick={() => {
                    setSelectedIds(rows.map((w) => w.id));
                  }}
                  disabled={rows.length === 0}
                >
                  全选
                </Button>
                <Button onClick={() => setSelectedIds([])} disabled={selectedIds.length === 0}>
                  清除勾选
                </Button>
              </Space>
            </Space>
          </Card>
          <Card size="small" title="单点视场预览" style={{ marginTop: 12 }}>
            {preview ? (
              <>
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="航点">#{preview.seq}（{preview.lng.toFixed(5)}, {preview.lat.toFixed(5)}）</Descriptions.Item>
                  <Descriptions.Item label="航高 / 航速 / 云台">
                    {preview.altitude} m / {preview.speed} m/s / {preview.gimbalPitch}°
                  </Descriptions.Item>
                  <Descriptions.Item label="视场覆盖">
                    旁向 {groundCoverage(mission.sensorWidth, preview.altitude, mission.focalLength)} m × 航向{' '}
                    {groundCoverage(mission.sensorHeight, preview.altitude, mission.focalLength)} m
                  </Descriptions.Item>
                  <Descriptions.Item label="单点 GSD">
                    {calcGsd(mission.pixelSize, preview.altitude, mission.focalLength)} cm/px
                  </Descriptions.Item>
                </Descriptions>
                <Row gutter={8} style={{ marginTop: 8 }}>
                  <Col span={8}>
                    <Statistic title="任务总航程" value={metrics.pathLength} precision={1} suffix="m" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计张数" value={metrics.estPhotos} suffix="张" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计耗时" value={metrics.estDuration} precision={1} suffix="min" />
                  </Col>
                </Row>
              </>
            ) : (
              <Empty description="暂无航点可预览" imageStyle={{ height: 40 }} />
            )}
          </Card>
        </Col>
        <Col span={14}>
          <Card size="small" title="航点位置（预览航点高亮）">
            <AmapRouteView
              mission={mission}
              waypoints={rows}
              altitude={preview?.altitude ?? 120}
              height={360}
              highlightSeq={preview?.seq}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="航点表格（勾选航点可整体平移；界外航点红行标注，移回测区前不能保存航线参数）">
        <Table<Waypoint>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1700 }}
          locale={{ emptyText: '暂无航点，请先粘贴导入' }}
          rowClassName={(row) => (outsideIds.has(row.id) ? 'waypoint-row-outside' : '')}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(String)),
            preserveSelectedRowKeys: true,
          }}
        />
      </Card>
    </Space>
  );
}
