#!/usr/bin/env python3
"""最后相机接入阶段：从实际棋盘格照片标定NIR相机，不打开相机或驱动车辆。"""
import argparse,json
from pathlib import Path
import cv2,numpy as np

p=argparse.ArgumentParser(description='实际棋盘照片标定；角点数量是内角点，方格边长单位米')
p.add_argument('images',type=Path);p.add_argument('--columns',type=int,required=True);p.add_argument('--rows',type=int,required=True);p.add_argument('--square-m',type=float,required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
if a.columns<3 or a.rows<3 or not 0<a.square_m<1:raise SystemExit('棋盘参数无效')
objects=np.zeros((a.rows*a.columns,3),np.float32);objects[:,:2]=np.mgrid[0:a.columns,0:a.rows].T.reshape(-1,2)*a.square_m
world=[];corners=[];files=[];size=None
for file in sorted(a.images.iterdir()):
 if file.suffix.lower() not in ['.png','.jpg','.jpeg','.bmp']:continue
 image=cv2.imread(str(file),cv2.IMREAD_GRAYSCALE)
 if image is None:continue
 current=(image.shape[1],image.shape[0])
 if size is not None and current!=size:raise SystemExit('照片分辨率不一致')
 size=current;ok,detected=cv2.findChessboardCorners(image,(a.columns,a.rows))
 if not ok:continue
 refined=cv2.cornerSubPix(image,detected,(11,11),(-1,-1),(cv2.TERM_CRITERIA_EPS+cv2.TERM_CRITERIA_MAX_ITER,40,.001));world.append(objects);corners.append(refined);files.append(file.name)
if len(world)<12:raise SystemExit('至少需要12张不同位置/倾角的清晰棋盘照片')
rms,k,d,rvecs,tvecs=cv2.calibrateCamera(world,corners,size,None,None)
errors=[]
for object,image,r,t in zip(world,corners,rvecs,tvecs):
 projected,_=cv2.projectPoints(object,r,t,k,d);errors.append(float(np.sqrt(np.mean(np.square(projected-image)))))
a.output.write_text(json.dumps({'width':size[0],'height':size[1],'cameraMatrix':k.tolist(),'distortion':d.ravel().tolist(),'rmsPixels':float(rms),'perImage':dict(zip(files,errors)),'calibrationVerified':False,'note':'这是相机内参估计；必须用独立照片复核，并测量base_link到camera_optical外参后接入CameraInfo/TF。'},ensure_ascii=False,indent=2))
print(f'标定照片{len(world)}张，RMS={rms:.3f}px，结果{a.output}；尚未自动设为验证通过')
