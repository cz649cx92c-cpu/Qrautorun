import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import { mapSchema, validate, type FieldMap } from '../../shared/model';
export class Store {
 db:Database.Database;
 constructor(path:string) {this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.exec('CREATE TABLE IF NOT EXISTS versions(map_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(map_id,version));');}
 list() {return this.db.prepare('SELECT v.map_id AS id,v.name,v.version,v.created FROM versions v JOIN (SELECT map_id,MAX(version) version FROM versions GROUP BY map_id) latest ON v.map_id=latest.map_id AND v.version=latest.version ORDER BY v.created DESC').all();}
 versions(id:string) {return this.db.prepare('SELECT version,created,name FROM versions WHERE map_id=? ORDER BY version DESC').all(id);}
 get(id:string,version?:number) {const q=version?this.db.prepare('SELECT body,version FROM versions WHERE map_id=? AND version=?').get(id,version):this.db.prepare('SELECT body,version FROM versions WHERE map_id=? ORDER BY version DESC LIMIT 1').get(id);if(!q) return null;const row=q as {body:string,version:number};return {map:mapSchema.parse(JSON.parse(row.body)),version:row.version};}
 save(raw:unknown,baseVersion:number) {const map=mapSchema.parse(raw); // 保存草稿允许保留几何错误，后端校验单独报告。
  return this.db.transaction(()=>{const current=this.get(map.id);if((current?.version??0)!==baseVersion) throw Object.assign(new Error('地图已被其他页面保存，请重新加载最新版本后再修改'),{statusCode:409});
   const version=baseVersion+1;this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?)').run(map.id,version,map.name,new Date().toISOString(),JSON.stringify(map));return {map,version,validation:validate(map)};
  })();
 }
 digest(map:FieldMap){return createHash('sha256').update(JSON.stringify(mapSchema.parse(map))).digest('hex');}
 close(){this.db.close();}
}
