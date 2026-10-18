"""已打印多码板的多视角内参标定，保留独立验证视角并拒绝退化采样。"""
import cv2
import numpy as np


def _v(h,i,j):
    return np.array([h[0,i]*h[0,j], h[0,i]*h[1,j]+h[1,i]*h[0,j],
                     h[1,i]*h[1,j], h[2,i]*h[0,j]+h[0,i]*h[2,j],
                     h[2,i]*h[1,j]+h[1,i]*h[2,j], h[2,i]*h[2,j]])


def calibrate_views(objects, pixels, size, diagnostics=None):
    # Optional diagnostics are populated before error rejection; callers can show
    # the actual final lens-model residuals without accepting a failed calibration.
    if diagnostics is not None:diagnostics.clear()
    if len(objects)!=len(pixels) or len(objects)<16:
        raise ValueError('至少需要16张不同倾角/位置的有效照片（12张拟合、4张独立验证）')
    width,height=size
    constraints=[]
    centers=[]
    for obj,px in zip(objects,pixels):
        if len(obj)<4 or len(obj)!=len(px) or not np.all(np.isfinite(obj)) or not np.all(np.isfinite(px)):
            raise ValueError('标定角点数据不完整')
        normalized=(np.asarray(px).reshape(-1,2)-[width/2,height/2])/width
        h,_=cv2.findHomography(np.asarray(obj)[:,:2],normalized)
        if h is None:raise ValueError('定位板角点不能求出平面关系')
        for row in (_v(h,0,1),_v(h,0,0)-_v(h,1,1)):
            constraints.append(row/np.linalg.norm(row))
        centers.append(np.mean(np.asarray(px).reshape(-1,2),axis=0))
    singular=np.linalg.svd(np.array(constraints),compute_uv=False)
    if singular[-2]/singular[0]<.005:
        raise ValueError('照片倾角变化不足；仅平移/旋转平放的板无法确定相机内参')
    spread=np.ptp(np.array(centers),axis=0)
    if spread[0]<width*.15 or spread[1]<height*.15:
        raise ValueError('定位板需要覆盖画面不同位置，不能只在中心反复拍摄')
    training=[i for i in range(len(objects)) if i%4!=3]
    heldout=[i for i in range(len(objects)) if i%4==3]
    world=[np.asarray(objects[i],np.float32) for i in training]
    image=[np.asarray(pixels[i],np.float32).reshape(-1,1,2) for i in training]
    rms,k,d,rvecs,tvecs=cv2.calibrateCamera(world,image,size,None,None,
        criteria=(cv2.TERM_CRITERIA_EPS+cv2.TERM_CRITERIA_MAX_ITER,100,1e-8))
    if not np.all(np.isfinite(k)) or not np.all(np.isfinite(d)) or not np.isfinite(rms):
        raise ValueError('标定结果不是有限值')
    if not .1*width<k[0,0]<10*width or not .1*height<k[1,1]<10*width or not .1*width<k[0,2]<.9*width or not .1*height<k[1,2]<.9*height:
        raise ValueError('标定焦距/主点异常，请重新采集不同倾角')
    normals=np.array([cv2.Rodrigues(r)[0][:,2] for r in rvecs])
    tilt_spread=np.linalg.svd(normals[:,:2]-np.mean(normals[:,:2],axis=0),compute_uv=False)/np.sqrt(len(normals))
    if tilt_spread[-1]<.08:
        raise ValueError('需要向两个不同方向倾斜定位板，不能只绕一个轴倾斜')
    per_view=[]
    for i,obj,px,r,t in zip(training,world,image,rvecs,tvecs):
        projected,_=cv2.projectPoints(obj,r,t,k,d)
        error=float(np.sqrt(np.mean(np.sum((projected.reshape(-1,2)-px.reshape(-1,2))**2,axis=1))))
        per_view.append({'index':i,'role':'training','rmsPixels':error,'thresholdPixels':.8,'excessive':error>.8})
    validation=[]
    for i in heldout:
        obj=np.asarray(objects[i],np.float64);px=np.asarray(pixels[i],np.float64).reshape(-1,2)
        ok,r,t=cv2.solvePnP(obj,px,k,d,flags=cv2.SOLVEPNP_ITERATIVE)
        if not ok:raise ValueError('独立验证照片不能求出位姿')
        projected,_=cv2.projectPoints(obj,r,t,k,d)
        error=float(np.sqrt(np.mean(np.sum((projected.reshape(-1,2)-px)**2,axis=1))))
        validation.append(error)
        per_view.append({'index':i,'role':'validation','rmsPixels':error,'thresholdPixels':1.2,'excessive':error>1.2})
    if diagnostics is not None:
        diagnostics.update(rmsPixels=float(rms),validationMaxPixels=max(validation),
                           trainingThresholdPixels=.8,validationThresholdPixels=1.2,
                           perView=sorted(per_view,key=lambda item:item['index']))
    if rms>.8 or max(validation)>1.2:
        raise ValueError(f'标定误差过大：拟合{rms:.2f}px，独立验证最大{max(validation):.2f}px')
    return {'width':width,'height':height,'cameraMatrix':k.tolist(),'distortion':d.ravel().tolist(),
            'rmsPixels':float(rms),'validationRmsPixels':validation,
            'trainingCount':len(training),'validationCount':len(heldout),
            'calibrationVerified':True,'diversityRatio':float(singular[-2]/singular[0]),
            'tiltDiversity':tilt_spread.tolist()}
