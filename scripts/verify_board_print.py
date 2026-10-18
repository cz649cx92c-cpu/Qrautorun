#!/usr/bin/env python3
"""实际PDF栅格校验：成员码ID/黑边尺寸和整组外尺寸，不冒充实物测试。"""
import sys,json
from pathlib import Path
import cv2
import numpy as np
directory=Path(sys.argv[1])
boards=json.loads((directory/'groups.json').read_text())
pages=sorted(p for p in directory.glob('page-*.png') if p.stem.removeprefix('page-').isdigit())
assert len(pages)==len(boards), '每页必须是一整组'
dictionary=cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
cv2.setNumThreads(2)
for path,board in zip(pages,boards):
    img=cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)
    corners,ids,_=cv2.aruco.detectMarkers(img,dictionary)
    assert ids is not None, f'{path} 无码'
    by_id={}
    for p,identifier in zip(corners,ids.ravel().tolist()):
        p=p[0]
        if identifier not in by_id or abs(cv2.contourArea(p))>abs(cv2.contourArea(by_id[identifier])):
            by_id[identifier]=p
    assert set(by_id)=={m['id'] for m in board['members']}, '遗漏或错误子码'
    scale=img.shape[1]/210
    for m in board['members']:
        p=by_id[m['id']];width=float(np.linalg.norm(p-np.roll(p,-1,axis=0),axis=1).mean())/scale
        assert abs(width-m['size']*1000)<1, (m['id'],width,m['size']*1000)
    pts=np.concatenate(list(by_id.values()))
    black_bounds=pts.max(axis=0)-pts.min(axis=0)
    # 组外两侧各有一个cell静区：黑边每边8cell，静区每边1cell。
    outer=black_bounds/scale+2*board['members'][0]['size']*1000/8
    assert np.max(np.abs(outer-board['sizeMm']))<1, (board['id'],outer,board['sizeMm'])
print(f"PASS: {len(boards)}组、{sum(len(b['members']) for b in boards)}子码，整组外尺寸与成员黑边尺寸正确；未实物打印。")
