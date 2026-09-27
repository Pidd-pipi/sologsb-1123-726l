import type { LngLat } from '../types/mission';
import { round } from './id';

/** 每度纬度对应的米数（近似） */
export const METERS_PER_DEG_LAT = 111320;

/** 指定纬度处每度经度对应的米数 */
export function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** 经纬度 → 以参考点为原点的米制平面坐标（等距圆柱近似） */
export function lngLatToMeters(point: LngLat, origin: LngLat): { x: number; y: number } {
  const [lng, lat] = point;
  const [oLng, oLat] = origin;
  return {
    x: (lng - oLng) * metersPerDegLng(oLat),
    y: (lat - oLat) * METERS_PER_DEG_LAT,
  };
}

/** 米制偏移 → 经纬度 */
export function metersToLngLat(x: number, y: number, origin: LngLat): LngLat {
  const [oLng, oLat] = origin;
  return [oLng + x / metersPerDegLng(oLat), oLat + y / METERS_PER_DEG_LAT];
}

/** 把点向东 / 向北平移给定米数（负数表示向西 / 向南），返回新经纬度 */
export function shiftLngLat(point: LngLat, eastM: number, northM: number): LngLat {
  return metersToLngLat(eastM, northM, point);
}

/** 两点间水平距离 m */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const p = lngLatToMeters(a, a);
  const q = lngLatToMeters(b, a);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/** 多边形面积 m²（鞋带公式，先投影到米制） */
export function polygonAreaM2(polygon: LngLat[]): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0];
  const pts = polygon.map((p) => lngLatToMeters(p, origin));
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** 航带路径总长度 m */
export function pathLengthMeters(points: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceMeters(points[i - 1], points[i]);
  }
  return total;
}

/** 多边形质心（作为投影原点） */
export function polygonCentroid(polygon: LngLat[]): LngLat {
  if (polygon.length === 0) return [0, 0];
  const sumLng = polygon.reduce((s, p) => s + p[0], 0);
  const sumLat = polygon.reduce((s, p) => s + p[1], 0);
  return [sumLng / polygon.length, sumLat / polygon.length];
}

/** 点到线段的距离（米制平面坐标下） */
function distToSegmentMeters(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 判断点是否在测区多边形内（射线法；落在边界上视为在内，容差 0.5 m） */
export function pointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  if (polygon.length < 3) return false;
  const EDGE_TOLERANCE_M = 0.5;
  const p = lngLatToMeters(point, point);
  const verts = polygon.map((v) => lngLatToMeters(v, point));
  for (let i = 0; i < verts.length; i += 1) {
    const j = i === 0 ? verts.length - 1 : i - 1;
    if (distToSegmentMeters(p, verts[j], verts[i]) <= EDGE_TOLERANCE_M) return true;
  }
  let inside = false;
  for (let i = 0; i < verts.length; i += 1) {
    const j = i === 0 ? verts.length - 1 : i - 1;
    const a = verts[i];
    const b = verts[j];
    const crosses = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** 过滤出落在测区多边形外的点（多边形不足 3 点时视为全部在内） */
export function filterOutsidePolygon<T extends { lng: number; lat: number }>(points: T[], polygon: LngLat[]): T[] {
  if (polygon.length < 3) return [];
  return points.filter((p) => !pointInPolygon([p.lng, p.lat], polygon));
}

/** 把经纬度等比投影到给定画布，返回 SVG 坐标 */
export interface Projector {
  toXY: (p: LngLat) => { x: number; y: number };
  toLngLat: (x: number, y: number) => LngLat;
  width: number;
  height: number;
}

export function createProjector(polygon: LngLat[], width: number, height: number, padding = 34): Projector {
  const lngs = polygon.map((p) => p[0]);
  const lats = polygon.map((p) => p[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const spanLng = maxLng - minLng || 0.001;
  const spanLat = maxLat - minLat || 0.001;
  const scale = Math.min((width - padding * 2) / spanLng, (height - padding * 2) / spanLat);

  const toXY = (p: LngLat) => ({
    x: round(padding + (p[0] - minLng) * scale, 2),
    // 纬度越大越靠上，SVG y 轴向下
    y: round(padding + (maxLat - p[1]) * scale, 2),
  });
  const toLngLat = (x: number, y: number): LngLat => [
    minLng + (x - padding) / scale,
    maxLat - (y - padding) / scale,
  ];
  return { toXY, toLngLat, width, height };
}

/** 地面分辨率 GSD cm/px： (像元 μm × 航高 m) / (焦距 mm × 10) */
export function calcGsd(pixelSizeUm: number, altitudeM: number, focalLengthMm: number): number {
  if (!focalLengthMm) return 0;
  return round((pixelSizeUm * altitudeM) / (focalLengthMm * 10), 2);
}

/** 地面覆盖幅宽 m：传感器尺寸 mm × 航高 m / 焦距 mm */
export function groundCoverage(sensorMm: number, altitudeM: number, focalLengthMm: number): number {
  if (!focalLengthMm) return 0;
  return round((sensorMm * altitudeM) / focalLengthMm, 2);
}

/** 航线间距 m = 旁向幅宽 × (1 − 旁向重叠率) */
export function lineSpacing(sensorWidthMm: number, altitudeM: number, focalLengthMm: number, overlapSidePct: number): number {
  return round(groundCoverage(sensorWidthMm, altitudeM, focalLengthMm) * (1 - overlapSidePct / 100), 2);
}

/** 拍照间隔 m = 航向幅宽 × (1 − 航向重叠率) */
export function photoInterval(sensorHeightMm: number, altitudeM: number, focalLengthMm: number, overlapForwardPct: number): number {
  return round(groundCoverage(sensorHeightMm, altitudeM, focalLengthMm) * (1 - overlapForwardPct / 100), 2);
}

/** 预计张数 */
export function estimatePhotos(lineLengthM: number, intervalM: number, lineCount: number): number {
  if (intervalM <= 0 || lineCount <= 0 || lineLengthM <= 0) return 0;
  const perLine = Math.ceil(lineLengthM / intervalM) + 1;
  return perLine * lineCount;
}

/** 预计耗时 min：总航程 / 速度 + 转弯与悬停附加 */
export function estimateDuration(totalLengthM: number, speedMs: number, waypointCount: number, hoverSecTotal: number): number {
  if (speedMs <= 0) return 0;
  const flySec = totalLengthM / speedMs;
  const turnSec = waypointCount * 4;
  return round((flySec + turnSec + hoverSecTotal) / 60, 1);
}

/** 预计电池组数（按每组 25 min 有效续航，留 20% 余量） */
export function estimateBatteries(durationMin: number): number {
  if (durationMin <= 0) return 0;
  return Math.max(1, Math.ceil(durationMin / 20));
}
