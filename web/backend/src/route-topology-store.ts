/**
 * 路线拓扑的持久化（独立表，不进入 route body）。
 *
 * 为什么独立表：`routeSchema` 是严格契约，把拓扑塞进 body 会让旧读取路径看到
 * 一个它不认识的字段，也可能被 `mapSchema`/`routeSchema` 的 parse 静默裁掉。
 * 拓扑是「路线的有向图表达」，与 points/motionSegments 并行存在、可各自演进。
 */
import Database from 'better-sqlite3';

export interface StoredRouteTopology {
  routeId: string;
  mapId: string;
  mapVersion: number;
  topology: unknown;
  updated: string;
}

export function routeTopologyTables(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS route_topologies(route_id TEXT PRIMARY KEY, map_id TEXT NOT NULL, map_version INTEGER NOT NULL, topology TEXT NOT NULL, updated TEXT NOT NULL);'
    + 'CREATE INDEX IF NOT EXISTS route_topologies_map_idx ON route_topologies(map_id);',
  );
}

export function listRouteTopology(db: Database.Database, routeId: string): StoredRouteTopology | null {
  const row = db.prepare('SELECT route_id,map_id,map_version,topology,updated FROM route_topologies WHERE route_id=?')
    .get(routeId) as {route_id: string; map_id: string; map_version: number; topology: string; updated: string} | undefined;
  if (!row) return null;
  return {
    routeId: row.route_id,
    mapId: row.map_id,
    mapVersion: row.map_version,
    topology: JSON.parse(row.topology),
    updated: row.updated,
  };
}

export function saveRouteTopology(
  db: Database.Database,
  input: {routeId: string; mapId: string; mapVersion: number; topology: unknown; updated: string},
): StoredRouteTopology {
  db.prepare(
    'INSERT INTO route_topologies(route_id,map_id,map_version,topology,updated) VALUES(?,?,?,?,?)'
    + ' ON CONFLICT(route_id) DO UPDATE SET map_id=excluded.map_id,map_version=excluded.map_version,topology=excluded.topology,updated=excluded.updated',
  ).run(input.routeId, input.mapId, input.mapVersion, JSON.stringify(input.topology), input.updated);
  return listRouteTopology(db, input.routeId)!;
}

export function deleteRouteTopology(db: Database.Database, routeId: string): number {
  return db.prepare('DELETE FROM route_topologies WHERE route_id=?').run(routeId).changes;
}

export function deleteRouteTopologiesForMap(db: Database.Database, mapId: string): number {
  return db.prepare('DELETE FROM route_topologies WHERE map_id=?').run(mapId).changes;
}
