<script setup lang="ts">
import {ArrowRight,Printer,Grid2X2,ScanLine,Route,Navigation,Lightbulb,MoveRight,CornerUpRight,BookOpen} from 'lucide-vue-next';
import Button from './ui/Button.vue';
const emit=defineEmits<{navigate:[page:'scan'|'navigate'|'print'|'camera']}>();
const steps=[
 {name:'打印二维码',icon:Printer,text:'选择定位组规格与尺寸，生成 PDF。以 100% / ACTUAL SIZE 打印，核对 50 mm 校对尺；中心十字对位线默认开启。',action:'前往打印',page:'print' as const},
 {name:'铺设',icon:Grid2X2,text:'按水平和垂直网格铺设定位板，实测并记录组中心。转弯、折返处布置定位组，完成相机内参与安装参数标定。',action:'检查相机',page:'camera' as const},
 {name:'扫描建图',icon:ScanLine,text:'开始扫描后使用手柄示教，沿计划路径经过各定位组。记录完整档位与轨迹，停稳后完成扫描并生成地图。',action:'前往扫描',page:'scan' as const},
 {name:'编辑路径',icon:Route,text:'选择已生成的导航地图，点击“编辑路径”。尽量沿码连线绘制，点击“自动串码”预览逐码纠正节点，确认车头朝向并保存新地图版本。',action:'查看导航地图',page:'navigate' as const},
 {name:'开始导航',icon:Navigation,text:'核对地图、任务与速度，把小车放到首个定位组并对齐车头。等待连接、定位和执行条件就绪，再由操作人员启动。',action:'查看导航控制',page:'navigate' as const}
];
const questions=[
 {q:'为什么“开始导航”不可用？',a:'先查看导航控制中的等待原因。常见原因是未选择任务、地图尚未接纳、定位地图版本不同、设备离线或执行条件未满足。静止预览有坐标并不代表运动定位已就绪。详细信息可展开“高级诊断”。'},
 {q:'地图点位草稿已保存，为什么没有导航地图？',a:'现有完成扫描流程仍要求有效的区间运动记录。缺少档位记录、区间运动校验未通过或观测不足时，只保存点位草稿，不会自动进入路径编辑。请查看扫描提示，补齐记录后生成地图。'},
 {q:'路径保存提示拐弯处缺少定位组，怎么办？',a:'每个转弯或折返位置都要对应定位组。请把拐点移到该组中心，再检查车头朝向。系统只在定位组边界停稳后切换前进、倒车或平移。'},
 {q:'保存后为什么路线两端缩短了？',a:'起终点会自动吸附到最近可直线串联的组中心，组外多余路线会截去。无需手动满足端点 3 cm 容差；编译产物直接使用精确组中心，仍须至少两个可串联定位组。'},
 {q:'为什么有些定位组是橙色、没有被串联？',a:'系统检查沿途 10 cm 内的码，只串联插入后仍能保持码间水平或垂直直线的中心。偏离码用橙色标记并显示偏离距离；建议把路线画过此码或调整铺码，不会为串码擅自在两码间加入直角换向。'},
 {q:'编辑提示地图版本冲突怎么办？',a:'其他页面已保存新版本。先保留当前设计信息，退出编辑并重新选择地图加载最新版本，再继续编辑；系统不会覆盖另一页面的新版本。'},
 {q:'十字线开关会改变定位板尺寸吗？',a:'不会。开关只改变打印对位线，子码、静区、组间距和校对尺保持一致。打印后仍应核对实际尺寸，并现场验证识别效果。'}
];
</script>
<template>
 <section class="guide-page" data-testid="user-guide">
  <div class="guide-intro"><div class="guide-symbol"><BookOpen :size="26"/></div><div><span class="eyebrow">快速上手</span><h2>从第一块定位板，到一条可执行路线</h2><p>按五步完成准备、建图与路线设计。每一步都能在控制台中找到对应工具。</p></div><Button size="sm" @click="emit('navigate','print')">准备定位板<ArrowRight :size="16"/></Button></div>
  <section class="guide-section"><div class="section-heading"><h2>五步操作流程</h2><span>建议首次使用按顺序完成</span></div><ol class="guide-flow"><li v-for="(step,i) in steps" :key="step.name"><div class="guide-step-title"><span>0{{i+1}}</span><component :is="step.icon" :size="18"/><h3>{{step.name}}</h3></div><p>{{step.text}}</p><button class="text-action" @click="emit('navigate',step.page)">{{step.action}}<ArrowRight :size="14"/></button></li></ol></section>
  <div class="guide-columns">
   <section class="guide-card"><div class="section-heading"><h2><Grid2X2 :size="18"/>二维码铺设要求</h2></div><ul class="guide-list"><li><b>正交网格，同一行共线</b><p>以组中心为基准布置水平行和垂直列。使用直尺、拉线或激光基准确认共线，避免仅凭目测定位。</p></li><li><b>间距按可见性确定</b><p>结合相机视野、安装高度、车身尺寸与现场标定确定间距，先做短路线验证。相邻执行区间的端点至少相距 8 cm；这只是系统下限，不是推荐铺设间距。</p></li><li><b>转弯与折返处必须有定位组</b><p>沿网格在每个换向位置布板，并保持组中心可识别。不要把定位组放在无法停稳或被遮挡的位置。</p></li><li><b>尺寸与编号保持一致</b><p>按原规格重印，不缩放、不裁掉白色静区；各组编号唯一，铺设后记录实际中心坐标。</p></li></ul></section>
   <section class="guide-card"><div class="section-heading"><h2><Route :size="18"/>路径编辑规则</h2></div><ul class="guide-list"><li><b>沿码连线，逐码纠正</b><p>路线尽量沿码连线画，经过越多定位越稳。沿途 10 cm 内且可直线串联的定位组都会成为纠正节点，每到下一码纠正一次；起终点自动吸附最近可串联组。</p></li><li><b>横平竖直，自动补齐拐点</b><p>默认吸附 5 cm 网格。横向距离较大时先水平后垂直，否则先垂直后水平；拖动路点也会重新正交布线。“自动串码”将路线改为串联节点间的直线连接；转弯与折返仍须落在定位组上。</p></li><li><b>车头朝向保持一致</b><p>0° 对应地图 +X，90° 对应 +Y。沿车头轴同向为前进、反向为倒车，横向为平移；前进与倒车须对齐车头轴，允许偏差约 5.7°。</p></li><li><b>先预览，再保存</b><p>查看虚线箭头和蓝色串联节点；橙色偏离码会跳过，并提示“建议把路线画过此码或调整铺码”。支持撤销、删除和清空。单条路径最长 50 m，保存后自动同步任务的地图版本。</p></li></ul><div class="guide-callout"><CornerUpRight :size="18"/><span>正交拐弯通过停稳换向完成，不要求小车在拐点原地转身。</span></div></section>
  </div>
  <section class="guide-section"><div class="section-heading"><h2><Lightbulb :size="18"/>常见问题</h2><span>遇到问题，先看页面中的等待原因</span></div><div class="guide-faq"><details v-for="item in questions" :key="item.q"><summary>{{item.q}}</summary><p>{{item.a}}</p></details></div></section>
  <div class="guide-footer"><MoveRight :size="18"/><span>准备就绪后，从打印定位板开始。</span><Button variant="outline" size="sm" @click="emit('navigate','print')">前往二维码 PDF</Button></div>
 </section>
</template>
