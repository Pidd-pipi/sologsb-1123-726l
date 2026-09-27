import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { pointInPolygon, shiftLngLat } from '../utils/geoCalc';
import type { LngLat } from '../types/mission';
import type { Waypoint, WaypointDraft } from '../types/waypoint';

/** 批量平移结果：applied=false 时 violations 列出平移后会越界的航点，且无任何点被移动 */
export interface ShiftResult {
  applied: boolean;
  eastM: number;
  northM: number;
  moved: Waypoint[];
  violations: Waypoint[];
}

interface WaypointState {
  items: Waypoint[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>;
  /** 勾选航点整体平移（东/北，米）；任一点目标位置越过测区边界则整批不执行 */
  shiftMany: (ids: string[], eastM: number, northM: number, polygon?: LngLat[]) => Promise<ShiftResult>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byMission: (missionId: string) => Waypoint[];
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.waypoints.toArray();
    rows.sort((a, b) => a.seq - b.seq);
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const record: Waypoint = { ...draft, id: newId('wp') };
    await db.waypoints.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...d, id: newId('wp') }));
    await db.waypoints.bulkPut(records);
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    await db.waypoints.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async shiftMany(ids, eastM, northM, polygon = []) {
    const targets = get().items.filter((it) => ids.includes(it.id));
    // 先算出每个点的目标位置；只要有一点越过测区边界，平移全部不执行
    const planned = targets.map((w) => {
      const [lng, lat] = shiftLngLat([w.lng, w.lat], eastM, northM);
      return {
        waypoint: w,
        lng: Number(lng.toFixed(6)),
        lat: Number(lat.toFixed(6)),
      };
    });
    const violations = polygon.length >= 3
      ? planned.filter((p) => !pointInPolygon([p.lng, p.lat], polygon)).map((p) => p.waypoint)
      : [];
    if (violations.length > 0) {
      return { applied: false, eastM, northM, moved: [], violations };
    }
    const moved: Waypoint[] = planned.map((p) => ({ ...p.waypoint, lng: p.lng, lat: p.lat }));
    await db.transaction('rw', db.waypoints, async () => {
      for (const m of moved) {
        await db.waypoints.update(m.id, { lng: m.lng, lat: m.lat });
      }
    });
    set({
      items: get().items.map((it) => {
        const m = moved.find((x) => x.id === it.id);
        return m ? { ...it, lng: m.lng, lat: m.lat } : it;
      }),
    });
    return { applied: true, eastM, northM, moved, violations: [] };
  },
  /** 与相邻航点交换序号 */
  async move(id, direction) {
    const list = get().byMission(get().items.find((it) => it.id === id)?.missionId ?? '');
    const index = list.findIndex((it) => it.id === id);
    const target = direction === 'up' ? list[index - 1] : list[index + 1];
    if (!target) return;
    await get().reorder(id, target.id);
  },
  async reorder(fromId, toId) {
    const from = get().items.find((it) => it.id === fromId);
    const to = get().items.find((it) => it.id === toId);
    if (!from || !to) return;
    const fromSeq = from.seq;
    await db.waypoints.update(from.id, { seq: to.seq });
    await db.waypoints.update(to.id, { seq: fromSeq });
    set({
      items: get().items.map((it) => {
        if (it.id === from.id) return { ...it, seq: to.seq };
        if (it.id === to.id) return { ...it, seq: fromSeq };
        return it;
      }),
    });
  },
  async removeByMission(missionId) {
    const ids = get().items.filter((it) => it.missionId === missionId).map((it) => it.id);
    await db.waypoints.bulkDelete(ids);
    set({ items: get().items.filter((it) => it.missionId !== missionId) });
  },
  async remove(id) {
    await db.waypoints.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byMission(missionId) {
    return get()
      .items.filter((it) => it.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
