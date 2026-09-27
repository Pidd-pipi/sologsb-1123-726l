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

/**
 * 按向东、向北米数平移一个经纬度点（等距圆柱近似，以该点自身纬度为参考）。
 * 同一组 (eastM, northM) 应用到一组点时，点间相对位置保持不变。
 */
export function shiftLngLat(point: LngLat, eastM: number, northM: number): LngLat {
  return metersToLngLat(eastM, northM, point);
}

/** 点是否落在多边形的某条边上（按米制距离做约 0.2 m 容差，兼容经纬度 6 位取整） */
function pointOnSegmentMeters(point: LngLat, a: LngLat, b: LngLat): boolean {
  const origin = a;
  const p = lngLatToMeters(point, origin);
  const pa = lngLatToMeters(a, origin);
  const pb = lngLatToMeters(b, origin);
  const cross = (pb.x - pa.x) * (p.y - pa.y) - (pb.y - pa.y) * (p.x - pa.x);
  const dot = (p.x - pa.x) * (p.x - pb.x) + (p.y - pa.y) * (p.y - pb.y);
  if (Math.abs(cross) > 0.2) return false;
  // 垂足在线段上（dot<=0）时距离即为垂线距离；端点情况由最近端点距离兜底
  if (dot <= 0) return true;
  return Math.hypot(p.x - pa.x, p.y - pa.y) <= 0.2 || Math.hypot(p.x - pb.x, p.y - pb.y) <= 0.2;
}

/**
 * 点是否在测区多边形内（射线法，边界点视为界内）。
 * 顶点不足 3 个无法构成多边形时不做越界判定，返回 true。
 */
export function pointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  if (polygon.length < 3) return true;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (pointOnSegmentMeters(point, polygon[i], polygon[j])) return true;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
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
