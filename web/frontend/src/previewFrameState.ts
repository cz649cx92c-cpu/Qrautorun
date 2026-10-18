// Frame age is anchored to the local monotonic clock after receipt.
// Old pictures remain visible, but are explicitly identified as delayed/stopped.
export function previewFrameState(hasFrame:boolean,updating:boolean,transportAgeMs:number,lastFrame:number,now:number){
 const ageMs=hasFrame?Math.round(Math.max(0,transportAgeMs)+Math.max(0,now-lastFrame)):0;
 const delayed=hasFrame&&ageMs>500;
 return {ageMs,delayed,label:!hasFrame?'等待画面':!updating?'画面已暂停':delayed?'画面有延迟':'实时画面'};
}
