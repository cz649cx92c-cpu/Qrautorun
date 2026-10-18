#!/usr/bin/env python3
"""独立 OpenCV 检测器验证官方码本输出与真正的 PDF 栅格打印输出。"""
from pathlib import Path
import cv2
root=Path(__file__).resolve().parents[1]
dir=root/'logs/print-verification'
dictionary=cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
parameters=cv2.aruco.DetectorParameters_create()
passed=0
for id in range(587):
    im=cv2.imread(str(dir/f'{id}.pbm'),cv2.IMREAD_GRAYSCALE)
    im=cv2.resize(im,(400,400),interpolation=cv2.INTER_NEAREST)
    _,ids,_=cv2.aruco.detectMarkers(im,dictionary,parameters=parameters)
    assert ids is not None and set(ids.ravel().tolist())=={id}, (id,ids)
    passed+=1
pdf_images=sorted(dir.glob('pdf-*.png'))
assert len(pdf_images)==2, '先运行 pdftoppm -r 150 -png logs/print-verification/tags.pdf logs/print-verification/pdf'
for id,p in enumerate(pdf_images):
    _,ids,_=cv2.aruco.detectMarkers(cv2.imread(str(p)),dictionary,parameters=parameters)
    assert ids is not None and set(ids.ravel().tolist())=={id}, (p,ids)
print(f'PASS: {passed}/587 官方图案均识别原ID；实际PDF两页均识别正确；未做实物打印或NIR硬件识别测试。')
