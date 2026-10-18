#!/usr/bin/env python3
"""独立OpenCV识别每张实际PDF栅格页，并校验全部ID与物理尺寸。不是实物打印结果。"""
import argparse
from pathlib import Path
import cv2
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('directory',type=Path)
parser.add_argument('--first',type=int,default=0)
parser.add_argument('--last',type=int,default=586)
parser.add_argument('--size-mm',type=float,default=80)
args=parser.parse_args()
dictionary=cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
parameters=cv2.aruco.DetectorParameters_create()
cv2.setNumThreads(2)
found=[]
pages=sorted(p for p in args.directory.glob('page-*.png') if p.stem.removeprefix('page-').isdigit())
assert pages, '请先用pdftoppm导出全部PDF页面'
for path in pages:
    image=cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)
    corners,ids,_=cv2.aruco.detectMarkers(image,dictionary,parameters=parameters)
    assert ids is not None, f'{path.name} 未识别到标记'
    # 多阈值检测可能返回同一纸上图案的嵌套候选，取同位置面积最大的外边界。
    # 同ID出现在两个不同位置仍然报错，不把真正重复的印码合并。
    markers={}
    for points,identifier in zip(corners,ids.ravel().tolist()):
        p=points[0]
        if identifier in markers:
            previous=markers[identifier]
            assert np.linalg.norm(p.mean(axis=0)-previous.mean(axis=0))<.1*np.linalg.norm(previous[0]-previous[1]), '同页不同位置出现重复ID'
            if abs(cv2.contourArea(p))<abs(cv2.contourArea(previous)):
                continue
        markers[identifier]=p
    found.extend(markers)
    for p in markers.values():
        sides=np.linalg.norm(p-np.roll(p,-1,axis=0),axis=1)
        width_mm=float(sides.mean())/(image.shape[1]/210.)
        assert abs(width_mm-args.size_mm)<1.5, (path.name,width_mm,args.size_mm)
assert len(found)==len(set(found)), '打印出现重复ID'
assert sorted(found)==list(range(args.first,args.last+1)), '打印漏码或出现错误ID'
print(f'PASS: {len(pages)}页PDF独立识别{len(found)}个唯一标记，ID {args.first}–{args.last}，黑边尺寸{args.size_mm}mm。尚未做实物打印。')
