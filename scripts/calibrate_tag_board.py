#!/usr/bin/env python3
"""从真实多码板照片求内参；不会使用仅一张地面照片猜焦距。"""
import argparse
import json
from pathlib import Path
import sys
import cv2
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.calibration_target import detect_target, validate_target
from greenhouse_navigation.calibration import calibrate_views

parser=argparse.ArgumentParser()
parser.add_argument('session',type=Path)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
try:
    metadata=json.loads((args.session/'session.json').read_text())
    target=metadata.get('target') or {'type':'registered','boardId':metadata['board']['id']}
    target=dict(target)
    if target['type']=='registered':target['board']=metadata['board']
    validate_target(target)
    if metadata.get('physicalScaleConfirmed') is not True:
        raise ValueError('需确认实际打印尺寸与定位板登记尺寸一致')
    cv2.setNumThreads(2)
    objects=[];pixels=[];files=[];analysis=[];size=None
    # 只读取会话中保留的照片；已删除或中断采集留下的文件不得参与计算。
    for sample in metadata['samples']:
        file=args.session/sample['file']
        if file.parent!=args.session or not file.name.startswith('frame-') or file.suffix!='.jpg':
            raise ValueError('标定照片路径无效')
        image=cv2.imread(str(file),cv2.IMREAD_GRAYSCALE)
        if image is None:
            analysis.append({'file':file.name,'valid':False,'reason':'照片不能解码'})
            continue
        current=(image.shape[1],image.shape[0])
        if size is not None and size!=current:raise ValueError('采集期间分辨率变化，请新建一组标定采集')
        size=current
        correspondence,diagnostic=detect_target(image,target)
        analysis.append({'file':file.name,**diagnostic})
        if correspondence is None:continue
        if target['type']=='aprilgrid' and target['family']=='auto':target['family']=diagnostic['family']
        obj,px=correspondence
        objects.append(obj);pixels.append(px);files.append(file.name)
    analysis_tmp=args.session/'analysis.json.tmp'
    analysis_tmp.write_text(json.dumps(analysis,ensure_ascii=False,indent=2))
    analysis_tmp.replace(args.session/'analysis.json')
    if len(files)<16:
        reasons=list(dict.fromkeys(a['reason'] for a in analysis if not a['valid']))
        raise ValueError(f'有效照片{len(files)}/{len(metadata["samples"])}张，至少需要16张。'+('；'.join(reasons[:3])))
    quality={}
    try:
        result=calibrate_views(objects,pixels,size,quality)
    finally:
        # Save rejected as well as accepted residuals, without changing intrinsics.
        for view in quality.pop('perView',[]):
            file=files[view.pop('index')]
            next(a for a in analysis if a['file']==file)['reprojection']=view
        analysis_tmp.write_text(json.dumps(analysis,ensure_ascii=False,indent=2))
        analysis_tmp.replace(args.session/'analysis.json')
        review_tmp=args.session/'review.json.tmp'
        review_tmp.write_text(json.dumps({'files':[s['file'] for s in metadata['samples']],**quality},ensure_ascii=False,indent=2))
        review_tmp.replace(args.session/'review.json')
    result.update(target=target,images=files,createdAt=metadata['createdAt'],
                  source=target['type']+'-multi-view',physicalScaleConfirmed=True)
    if target['type']=='registered':result['board']=metadata['board']
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temporary=args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    temporary.replace(args.output)
    print(json.dumps({'ok':True,'result':result},ensure_ascii=False))
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False))
    raise SystemExit(1)
