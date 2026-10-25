/**
 * 地图实时车体图标尺寸回归（v8）。
 *
 * 背景：导航监视页的车体图标明显大于实车。根因是画布直接用了 map.vehicle 的
 * 设计占位包络（length 0.8 m × width 0.4 m），而不是真实整车外形
 * （0.46 m × 0.36 m）。占位值还带 margin，是给 validate() 做行宽余量和
 * 退出距离校验用的安全包络，本就不该拿来当图标尺寸。
 *
 * 必须满足：
 *   1) 车体按世界米制尺寸（0.46 × 0.36）绘制，随地图缩放一起缩放；
 *   2) 不得出现固定像素下限/固定像素膨胀（不能用 Math.max 把尺寸顶到最小像素）；
 *   3) 锚点仍是 base_link（矩形以 group 原点为中心），航向取 yaw，长轴沿前进方向（本地 +x）；
 *   4) map.vehicle 仍是规划/安全包络，显示常量不得写回地图、不得参与 validate()；
 *   5) 不改底盘运动学：显示长度不是轮距/轴距。
 *
 * 本文件只读源码，不启动服务、不发 cmd_vel、不修改任何地图或数据库。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {vehicleFootprintM} from '../web/shared/model';

const canvasSource=readFileSync(new URL('../web/frontend/src/components/MapCanvas.vue',import.meta.url),'utf8');
const modelSource=readFileSync(new URL('../web/shared/model.ts',import.meta.url),'utf8');
// 静态扫描只看可执行代码：注释里会解释“不再用 map.vehicle”，不能当成违规。
const canvasScript=canvasSource.split('<script setup lang="ts">')[1]!.split('</script>')[0]!;
const canvasCode=canvasScript.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const drawOverlay=canvasCode.slice(canvasCode.indexOf('function drawOverlay('));
const vehicleBlock=drawOverlay.slice(drawOverlay.indexOf('if(props.vehicle)'),drawOverlay.indexOf('}else if(vehicleGroup)'));

test('显示外形是真实整车 0.46 m × 0.36 m，且带 const 断言不可被写回',()=>{
 assert.equal(vehicleFootprintM.length,0.46,'车体显示长度应为 0.46 m');
 assert.equal(vehicleFootprintM.width,0.36,'车体显示宽度应为 0.36 m');
 assert.ok(vehicleFootprintM.length>vehicleFootprintM.width,'长轴必须大于短轴，长轴沿前进方向');
 assert.match(modelSource,/vehicleFootprintM\s*=\s*\{\s*length:0\.46\s*,\s*width:0\.36\s*\}\s*as const/);
});

test('画布用显示外形常量，不再拿 map.vehicle 当图标尺寸',()=>{
 assert.match(canvasCode,/vehicleFootprintM/,'MapCanvas 必须引用显示外形常量');
 assert.equal(/props\.map\.vehicle/.test(vehicleBlock),false,'实时车体不得再用 map.vehicle 的规划包络');
 assert.equal(/const\s*\{\s*length\s*,\s*width\s*\}\s*=\s*props\.map\.vehicle/.test(canvasCode),false);
});

test('车体按世界米制尺寸绘制，随地图缩放，无固定像素下限',()=>{
 // 100 px/m 是本画布的世界单位换算，车身像素尺寸必须由米制尺寸乘出来。
 assert.match(vehicleBlock,/vehicleFootprintM\.length\*100/);
 assert.match(vehicleBlock,/vehicleFootprintM\.width\*100/);
 // 不得用 Math.max 给车身顶一个最小像素，否则低缩放下会被固定像素膨胀。
 assert.equal(/Math\.max\(/.test(vehicleBlock),false,'车体绘制不得出现固定像素下限/膨胀');
 // 不得直接写死像素尺寸。
 assert.equal(/(width|height):\s*\d+(\.\d+)?\s*[,}]/.test(vehicleBlock),false,'车体不得写死像素宽高');
});

test('锚点仍是 base_link：矩形以 group 原点居中，航向取 yaw',()=>{
 assert.match(vehicleBlock,/x:-bodyLength\/2/);
 assert.match(vehicleBlock,/y:-bodyWidth\/2/);
 assert.match(vehicleBlock,/width:bodyLength/);
 assert.match(vehicleBlock,/height:bodyWidth/);
 assert.match(vehicleBlock,/vehicleGroup\.position\(\{x:props\.vehicle\.x\*100,y:-props\.vehicle\.y\*100\}\)/);
 assert.match(vehicleBlock,/vehicleGroup\.rotation\(-props\.vehicle\.yaw\*180\/Math\.PI\)/);
});

test('长轴沿本地 +x（前进方向），航向指示不越出车体轮廓',()=>{
 // 箭头指向 +x，且终点在车身半长以内，避免描边把轮廓撑大。
 assert.match(vehicleBlock,/vehicleArrow!\.points\(\[0,0,bodyLength\*\.\d+,0\]\)/);
 const fraction=Number('0.'+/vehicleArrow!\.points\(\[0,0,bodyLength\*\.(\d+),0\]\)/.exec(vehicleBlock)![1]);
 const ratio=fraction;
 assert.ok(ratio>0&&ratio<0.5,`航向箭头终点比例 ${ratio} 必须小于 0.5（车身半长）`);
 assert.match(vehicleBlock,/pointerWidth:bodyWidth\*\.\d+/);
 assert.match(vehicleBlock,/pointerLength:bodyWidth\*\.\d+/);
});

test('规划/安全包络不变：map.vehicle 仍含 margin 并参与校验',()=>{
 assert.match(modelSource,/vehicle:z\.object\(\{width:z\.number\(\)\.min\(0\.1\)\.max\(1\),length:z\.number\(\)\.min\(0\.2\)\.max\(3\),margin:z\.number\(\)\.min\(0\.01\)\.max\(0\.1\)\}\)/);
 assert.match(modelSource,/map\.vehicle\.length\/2\+map\.vehicle\.margin/);
 assert.match(modelSource,/map\.vehicle\.width\+2\*map\.vehicle\.margin/);
 // 显示常量不得进入 schema 或校验逻辑。
 const validateBody=modelSource.slice(modelSource.indexOf('export function validate('));
 assert.equal(validateBody.includes('vehicleFootprintM'),false,'validate() 不得使用显示外形');
});

test('显示尺寸不是轮距/轴距：不进入后端建图与底盘配置',()=>{
 for(const file of ['../web/backend/src/scan-map.ts','../web/backend/src/map-only.ts','../web/backend/src/survey.ts']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  assert.equal(source.includes('vehicleFootprintM'),false,`${file} 不应引用显示外形`);
  assert.match(source,/vehicle:\{width:\.4,length:\.8,margin:\.05\}/,'建图仍写入原规划包络，未被显示尺寸污染');
 }
});
