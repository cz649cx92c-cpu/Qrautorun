/**
 * 融合标定前端的静态回归：只读源码，不依赖 DOM。
 *
 * 目的：
 * 1. 地图区域删掉“测量人员”后，旧地图仍可确认（不再强制 operator）。
 * 2. 融合标定工作区只调用标定 API，绝不出现运动/导航/解锁入口。
 * 3. 页面文案必须区分“可计算 / 依赖假设 / 缺数据”，并明确 dry-run 未应用。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const read=(relative:string)=>readFileSync(fileURLToPath(new URL(relative,import.meta.url)),'utf8');
const app=read('../web/frontend/src/App.vue');
const workspace=read('../web/frontend/src/components/CalibrationWorkspace.vue');
// 注释里允许说明“不调用某接口”，静态扫描只针对可执行代码。
const workspaceCode=workspace.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*$/gm,'');

test('地图验收区域已删除测量人员，且确认/统一朝向不再强制 operator',()=>{
 assert.equal(app.includes('测量人员'),false,'App.vue 不应再出现“测量人员”');
 assert.equal(app.includes('请填写确认人姓名'),false,'不应再有确认人必填校验');
 assert.equal(app.includes('operator:verification'),false,'不应再把 verification.operator 传给后端');
 assert.equal(app.includes('const operator='),false,'不应再读取 operator 本地校验');
 // 自用版：切图即生效，前端不再调用 /maps/confirm（旧接口保留兼容，由 personal-ui-simple / auto-map-select 覆盖）。
 assert.equal(app.includes("api('/maps/confirm'"),false,'切图即生效后前端不应再调用 /maps/confirm');
 assert.match(app,/api\('\/maps\/unify-angles',\{mapId:field\.value\.id,version:version\.value,confirm:true,updateTasks:true\}\)/,'/maps/unify-angles 仍应提交 mapId/version/confirm/updateTasks');
 // 自用版 UI 已取消“手工实测坐标”表单：前端不再提交 /maps/accept，
 // 但后端该接口保留（旧数据与实测验收仍然兼容），由 personal-ui-simple 回归覆盖。
 assert.equal(app.includes("api('/maps/accept'"),false,'自用版 UI 不应再提交手工实测坐标');
});

test('导航新增“融合标定”入口，摄像头预览入口已移除',()=>{
 assert.match(app,/type ConsolePage='scan'\|'navigate'\|'print'\|'calibration'/);
 assert.match(app,/nav-calibration/);
 assert.match(app,/融合标定/);
 assert.match(app,/calibration:\{title:'融合标定'/);
 // KeepAlive 必须常驻在 v-if/v-else-if 链之外：写进链里会让切页把 KeepAlive 自己卸载，缓存失效。
 assert.match(app,/<KeepAlive>\s*<CalibrationWorkspace v-if="page==='calibration'" :maps="maps"\/>\s*<\/KeepAlive>/,'融合标定应使用常驻 KeepAlive 保留页面状态');
 assert.equal(/<KeepAlive v-else-if=/.test(app),false,'KeepAlive 不得再写成 v-else-if 分支');
 assert.ok(app.includes("v-else-if=\"page!=='calibration'\""),'控制台分支应排除 calibration');
 for(const page of ['scan','navigate','print'])assert.ok(app.includes(`page==='${page}'`),`原有页面 ${page} 入口不应被破坏`);
 assert.equal(app.includes("page==='camera'"),false,'摄像头预览前端入口应已移除');
});

test('融合标定工作区只读调用标定 API，不出现任何运动/导航指令',()=>{
 for(const endpoint of ['/calibration/capabilities','/calibration/sessions','/trials','/stop','/abort','/analyze','/analysis','/apply','/export']){
  assert.ok(workspace.includes(endpoint),`缺少标定接口 ${endpoint}`);
 }
 for(const forbidden of ['/api/navigation','/navigation/','cmd_vel','/robot/commands','解锁','unlock']){
  assert.equal(workspaceCode.includes(forbidden),false,`融合标定页面不得包含 ${forbidden}`);
 }
 assert.equal(workspaceCode.includes('performance.now'),false,'前端不得生成采样时间戳');
 assert.equal(workspaceCode.includes('Date.now'),false,'前端不得生成采样时间戳');
 assert.match(workspace,/import type \{CalibrationSession,CalibrationTrial,SessionAnalysis,Stats,TrialAnalysis,TrialStatus,TrialType\} from '\.\.\/\.\.\/\.\.\/shared\/calibration'/,'共享类型应来自 web/shared/calibration.ts');
});

test('旋转试验必须能选“在哪个二维码处转”，并把 rotationTagId 提交给后端',()=>{
 // 选择器：选项来自当前地图的二维码
 assert.ok(workspace.includes('data-testid="trial-rotation-tag"'),'转向试验必须有旋转二维码选择器');
 assert.ok(workspace.includes('v-for="tag in mapTags"'),'选择器选项应来自当前地图二维码');
 // 提交体：转向带 rotationTagId，前进/后退明确为 null
 assert.ok(workspace.includes('rotationTagId:isTurn.value?Number(trialForm.value.rotationTagId):null'),'试验请求体必须带 rotationTagId，前进/后退为 null');
 // 现场拦截：转向没选码就不让开始
 assert.ok(workspace.includes("trialForm.value.rotationTagId===''"),'转向未选二维码时必须在前端拦住');
 assert.ok(workspace.includes('转向试验必须选择旋转发生处的二维码'),'缺少旋转二维码要有明确提示');
 // 统一文案：在 Q113 处左转90°
 assert.ok(workspace.includes('在 ${label} 处'),'文案应形如“在 Q113 处左转90°”');
 assert.ok(workspace.includes('缺数据（未指定旋转二维码）'),'缺码时显示缺数据而不是猜一个');
 assert.ok(workspace.includes('不适用（前进/后退不要求）'),'前进/后退不强制该字段');
 // 结果与汇总都要显示旋转位置
 assert.ok(workspace.includes("'trial-rotation-'+trial.trialId"),'每次试验结果要显示旋转位置');
 assert.ok(workspace.includes("'aggregate-rotation'"),'汇总要显示旋转位置');
 assert.ok(workspace.includes('rotationTags'),'汇总应读取按二维码聚合的旋转位置');
 assert.ok(workspace.includes('measuredAngleDeg'),'结果要显示实测转角');
 assert.ok(workspace.includes('targetAngleDeg'),'结果要显示目标转角');
 assert.ok(workspace.includes('pairingLabel(trial)'),'结果要显示端点配对是哪两块码');
});

test('旧版（schemaVersion 1/2）已存分析缺字段时不得让整页崩溃',()=>{
 // 库里存着 schemaVersion 1 的旧分析结果：没有 aggregate.excluded / validTrials / rotationTags。
 // 模板里直接写 analysis.aggregate.excluded.length 会抛 TypeError，Vue 渲染中断 → 整个标定页变白。
 assert.equal(/analysis\.aggregate\.excluded\.length/.test(workspace),false,'不得直接访问 analysis.aggregate.excluded.length');
 assert.equal(/analysis\.limitations\.length/.test(workspace),false,'不得直接访问 analysis.limitations.length');
 assert.ok(workspace.includes("const excludedRows=computed(()=>analysis.value?.aggregate.excluded??[])"),'已排除项必须走 ??[] 兜底');
 assert.ok(workspace.includes('const validTrialsLabel=computed('),'有效试验数必须走兜底 computed');
 assert.ok(workspace.includes('v-if="excludedRows.length"'),'已排除项渲染应使用兜底后的 excludedRows');
 assert.ok(workspace.includes('v-for="item in excludedRows"'),'已排除项循环应使用兜底后的 excludedRows');
 assert.ok(workspace.includes('{{validTrialsLabel}}'),'有效试验数应使用兜底后的 validTrialsLabel');
 assert.ok(workspace.includes('values:outliers.forwardScale??[]'),'离群项缺字段时应按空数组兜底');
 assert.ok(workspace.includes('const rows=agg.rotationTags??[]'),'旋转位置聚合缺字段时应按空数组兜底');
 assert.ok(workspace.includes('analysis.limitations?.length'),'限制列表应可选链访问');
});

test('页面明确区分可计算/依赖假设/缺数据，并显示 dry-run 未应用与采集能力',()=>{
 for(const text of ['可计算','依赖假设','缺数据','两码真实中心距离','未应用','应用到运行参数','请检查桥接服务是否已加载被动录音支持']){
  assert.ok(workspace.includes(text),`缺少关键文案：${text}`);
 }
 assert.match(workspace,/applied\?'已应用':'未应用'/,'应用结果必须区分已应用/未应用');
 assert.match(workspace,/proposed\[row\.key\]/,'应展示 proposed 候选值');
 assert.match(workspace,/current\[row\.key\]/,'应展示 current 当前值');
 for(const format of ["exportUrl('json')","exportUrl('csv')","exportUrl('report')"])assert.ok(workspace.includes(format),`缺少导出 ${format}`);
 assert.match(workspace,/nodeRecorder\.supported/,'应展示采集节点是否支持');
 assert.match(workspace,/lastSampleAt/,'应展示最后样本时间');
});

test('清空当前会话试验：按钮只在有试验时出现，二次确认写清后果，取消不发请求',()=>{
 // 入口：只在当前会话有试验时显示，录制中禁用
 assert.ok(workspace.includes('data-testid="clear-trials"'),'缺少清空按钮');
 assert.ok(workspace.includes('清空当前会话试验'),'按钮文案应为「清空当前会话试验」');
 assert.ok(workspace.includes('v-if="trials.length"'),'没有试验时不应显示清空按钮');
 assert.ok(workspace.includes(':disabled="busy||!!recordingTrial" data-testid="clear-trials"'),'录制中必须禁用清空按钮');
 // 二次确认：文案必须写清“删什么、不删什么、不能撤销”
 assert.ok(workspace.includes('data-testid="clear-trials-confirm"'),'缺少二次确认框');
 assert.ok(workspace.includes('删除本会话试验与样本，不可撤销'),'确认文案必须写清后果');
 assert.ok(workspace.includes('data-testid="clear-trials-cancel"'),'缺少取消按钮');
 assert.ok(workspace.includes('data-testid="clear-trials-confirm-yes"'),'缺少确认按钮');
 // 取消只关弹层，不发请求
 assert.ok(workspace.includes('@click="clearConfirm=false"'),'取消必须只关闭确认框');
 assert.equal(/clearConfirm=false[\s\S]{0,40}request\(/.test(workspace),false,'取消分支不得发请求');
 // 请求：DELETE + 显式确认参数
 assert.match(workspace,/'DELETE'/,'必须使用 DELETE 方法');
 assert.ok(workspace.includes('confirm=clear-trials'),'必须带显式确认参数 confirm=clear-trials');
 assert.ok(workspace.includes('trials?confirm=clear-trials'),'清空接口应指向 sessions/:id/trials');
 // 成功后：清本地分析态 + 重新拉会话/试验 + 显示清空数量
 assert.ok(workspace.includes('await reloadCurrent();await loadSessions();'),'成功后必须刷新会话与试验');
 assert.ok(workspace.includes('deletedTrials'),'提示必须带删除的试验数');
 assert.ok(workspace.includes('deletedSamples'),'提示必须带删除的样本数');
 assert.ok(workspace.includes('已清空本会话试验：删除'),'成功后要有明确提示');
});

test('录制横幅固定可见：结束记录/中止直接放在横幅里，并自动滚到最新试验',()=>{
 // 横幅本身只在录制时出现，所以按钮天然可用；busy 时统一禁用。
 assert.ok(workspace.includes('data-testid="recording-banner"'),'缺少录制横幅');
 assert.ok(workspace.includes('data-testid="recording-stop"'),'录制横幅里必须有「结束记录」');
 assert.ok(workspace.includes('data-testid="recording-abort"'),'录制横幅里必须有「中止」');
 assert.ok(workspace.includes('@click="stopTrial(recordingTrial)"'),'横幅按钮必须复用 stopTrial');
 assert.ok(workspace.includes('@click="abortTrial(recordingTrial)"'),'横幅按钮必须复用 abortTrial');
 assert.equal((workspace.match(/:disabled="busy" data-testid="recording-stop"/g)??[]).length,1,'结束记录按钮在 busy 时必须禁用');
 assert.equal((workspace.match(/:disabled="busy" data-testid="recording-abort"/g)??[]).length,1,'中止按钮在 busy 时必须禁用');
 // 横幅吸顶：滚动页面时按钮仍然可见
 assert.match(workspace,/\.cw-recording\{[^}]*position:sticky/,'录制横幅必须吸顶，滚动时按钮仍可见');
 assert.match(workspace,/\.cw-recording\{[^}]*top:0/,'吸顶需要 top:0');
 // 列表自动滚到最新一条（新试验追加在末尾，列表限高 420px）
 assert.ok(workspace.includes('const trialListRef=ref<HTMLElement|null>(null)'),'列表需要 ref 才能自动滚动');
 assert.ok(workspace.includes('ref="trialListRef"'),'试验列表必须挂上 trialListRef');
 assert.ok(workspace.includes('list.scrollTop=list.scrollHeight'),'新试验/开始录制后必须把列表滚到最新一条');
 assert.ok(workspace.includes("watch(()=>[trials.value.length,recordingTrial.value?.id??''] as const"),'试验数或录制态变化时应触发自动滚动');
 // 不能为了省空间把历史试验隐藏掉
 assert.ok(workspace.includes('v-for="trial in trials"'),'历史试验列表仍要完整渲染');
});

test('转向显示统一：目标角带旋向文案，不再把正目标角与带符号实测角混成看似相反',()=>{
 // 内部符号约定保留（左正右负），但页面只显示「右转 90°（顺时针）」
 assert.ok(workspace.includes("const senseLabel:Record<'left'|'right',string>={left:'逆时针',right:'顺时针'}"),'必须有旋向文案表');
 assert.ok(workspace.includes('return `${Math.abs(item.angleDeg)}°（${senseLabel[item.type===\'right\'?\'right\':\'left\']}）`'),'目标角显示必须带旋向');
 assert.ok(workspace.includes('function turnAnglePairLabel(trial:TrialAnalysis)'),'目标/实测必须走统一的并列文案');
 assert.ok(workspace.includes('trial.targetAnglePhrase??'),'优先用后端算好的目标角文案，旧数据再兜底');
 assert.ok(workspace.includes('{{turnAnglePairLabel(trial)}}'),'结果卡必须用统一文案');
 assert.ok(workspace.includes('{{targetAngleText(trial)}}'),'试验行与分析卡标题必须用带旋向的目标角');
 assert.equal(workspace.includes("trial.angleDeg+'°'"),false,'不得再把带符号的 angleDeg 直接甩给用户');
 // 方向相反要有明确标记，并且计数进汇总
 assert.ok(workspace.includes("'trial-mismatch-'+trial.trialId"),'方向相反的试验必须有显式标记');
 assert.ok(workspace.includes('data-testid="\'aggregate-mismatch\'"'),'汇总必须显示方向相反的次数');
 assert.ok(workspace.includes('turnTrialsDirectionMismatch??'),'汇总计数要兼容旧分析结果');
 assert.ok(workspace.includes('measuredAngleMagnitudeDeg'),'汇总必须给出实测转角幅值（左右混算时才有意义）');
});

test('切页保留标定设置：KeepAlive 常驻 + 重新激活不重置本地表单、不写 localStorage',()=>{
 // 设置项全部是 setup 作用域的 ref：只要实例不被销毁，切页回来就还在。
 for(const declaration of [
  "current=ref<SessionDetail|null>(null)",
  "const selectedMapId=ref('')",
  "const form=ref<{tagA:number|''",
  "const trialForm=ref<{type:TrialType",
 ]){
  assert.ok(workspace.includes(declaration),`状态必须是组件内 ref：${declaration}`);
 }
 // 重新激活只刷新服务端数据（preserveLocal=true），绝不覆盖本地表单。
 assert.ok(workspace.includes('onActivated(()=>{void loadCapabilities();void loadSessions();if(current.value)void reloadCurrent(true);startPolling();})'),'onActivated 必须以 preserveLocal=true 刷新');
 assert.ok(workspace.includes('async function reloadCurrent(preserveLocal=false)'),'reloadCurrent 必须有 preserveLocal 开关');
 assert.ok(workspace.includes('if(preserveLocal)return;'),'preserveLocal 时必须直接返回，不覆盖 analysis/apply 状态');
 // 切页离开只停轮询，不重置设置、不发请求。
 assert.ok(workspace.includes('onDeactivated(stopPolling)'),'onDeactivated 只应停止轮询');
 assert.equal(/onDeactivated\([^)]*(selectedMapId|form\.value|trialForm\.value)/.test(workspace),false,'onDeactivated 不得重置设置');
 assert.equal(/localStorage|sessionStorage/.test(workspace),false,'不得用 localStorage/sessionStorage 伪造持久化');
 assert.equal(/localStorage|sessionStorage/.test(app),false,'App.vue 也不得写 localStorage/sessionStorage');
 // 地图选择被 props.maps 覆盖的兜底不能反过来清空用户选择：只有当前值不在列表里才改。
 assert.ok(workspace.includes('if(!selectedMapId.value||!list.some(map=>map.id===selectedMapId.value))selectedMapId.value=list[0]!.id'),'只有当前选择失效时才回退到第一张地图');
});

test('目标/实测转角并列：实测显式带正负号，旧分析缺字段时降级不白屏',()=>{
 // 「右转 90°（顺时针）/ 实测 -88.63°」「左转 90°（逆时针）/ 实测 +88.63°」
 assert.ok(workspace.includes('function signedAngleText('),'必须有带符号角度的统一格式化函数');
 assert.ok(workspace.includes("return `${value>0?'+':''}${value.toFixed(digits)}`"),'正数实测角必须显式补 + 号');
 assert.ok(workspace.includes('实测 ${signedAngleText(trial.measuredAngleDeg)}°'),'目标/实测并列必须用带符号实测角');
 assert.ok(workspace.includes('trial.targetAngleDeg??trial.angleDeg??null'),'旧分析没有 targetAngleDeg 时必须回退到 angleDeg，而不是显示 NaN');
 assert.equal(/实测 \$\{fmt\(trial\.measuredAngleDeg/.test(workspace),false,'实测角不得再走无符号 fmt');
 // 旧口径分析结果（schemaVersion 1/2 或缺少 excluded/validTrials/outliers/limitations）只提示，不自动重算。
 assert.ok(workspace.includes('const legacyAnalysisHint=computed('),'必须有旧口径分析提示');
 assert.ok(workspace.includes("if(!aggregate||aggregate.excluded===undefined)missing.push('excluded')"),'必须探测 excluded 缺失');
 assert.ok(workspace.includes("if(!aggregate||aggregate.validTrials===undefined)missing.push('validTrials')"),'必须探测 validTrials 缺失');
 assert.ok(workspace.includes("if(!aggregate||aggregate.outliers===undefined)missing.push('outliers')"),'必须探测 outliers 缺失');
 assert.ok(workspace.includes("if(!Array.isArray(current.limitations))missing.push('limitations')"),'必须探测 limitations 缺失');
 assert.ok(workspace.includes('data-testid="analysis-legacy"'),'旧口径分析要有可见提示（不白屏）');
 assert.ok(workspace.includes('点「分析」可按新口径重算，不会自动改写已保存结果'),'旧分析提示必须说明只有点击分析才更新');
 assert.ok(workspace.includes('analysis.value?.aggregate.excluded??[]'),'缺少 excluded 时按空数组降级');
 // 旧分析缺少方向标记字段时，汇总必须说明“未标记”，不能显示“无”。
 assert.ok(workspace.includes("return '旧分析未标记（点「分析」按新口径重算）'"),'旧分析缺方向标记时必须如实说明未标记');
 assert.ok(workspace.includes('hasMismatchField'),'必须探测方向标记字段是否存在');
 assert.ok(workspace.includes("missing.push('方向相反标记')"),'旧口径提示应包含方向相反标记缺失');
 // 旧分析缺 baselineResidual 字段时显示不适用，不显示 “— m”。
 assert.ok(workspace.includes("trial.baselineResidual==null?'不适用"),'baselineResidual 缺失（undefined）也要按不适用降级');
});
