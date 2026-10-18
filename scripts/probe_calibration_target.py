#!/usr/bin/env python3
"""检查共享预览的一帧，不另开摄像头、不发布ROS或运动命令。"""
import json
import sys
from pathlib import Path
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.calibration_target import detect_target
try:
    cv2.setNumThreads(2)
    gray=cv2.imdecode(np.frombuffer(sys.stdin.buffer.read(8*1024*1024),np.uint8),cv2.IMREAD_GRAYSCALE)
    if gray is None:raise ValueError('摄像头帧不能解码')
    _,result=detect_target(gray,json.loads(sys.argv[1]))
    print(json.dumps({'ok':True,'result':result},ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False))
    raise SystemExit(1)
