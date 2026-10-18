#!/usr/bin/env python3
"""从保留许可证的 AprilRobotics 官方源码提取码本。"""
import json, re, hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=root/'web/assets/tag36h11.c'
s=p.read_text()
codes=re.findall(r'0x([0-9a-f]+)UL',s)
xs=[int(v) for _,v in re.findall(r'tf->bit_x\[(\d+)\] = (\d+);',s)]
ys=[int(v) for _,v in re.findall(r'tf->bit_y\[(\d+)\] = (\d+);',s)]
assert len(codes)==587 and len(xs)==len(ys)==36
(root/'web/assets/tag36h11.json').write_text(json.dumps({'codes':codes,'bitX':xs,'bitY':ys,'source':'https://github.com/AprilRobotics/apriltag/blob/master/tag36h11.c','sha256':hashlib.sha256(p.read_bytes()).hexdigest()},indent=2))
