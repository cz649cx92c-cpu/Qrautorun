"""专用AprilGrid和棋盘格只用于内参标定，不注册为导航地图节点。"""
import math
import cv2
import numpy as np
from .board_geometry import validate_boards
from .vision import board_correspondences, printed_marker_detections

FAMILIES = ('tag36h11', 'tag36h10', 'tag25h9', 'tag16h5')


def dictionary(family):
    if family not in FAMILIES:
        raise ValueError('不支持的AprilTag码族')
    return cv2.aruco.Dictionary_get(getattr(cv2.aruco, 'DICT_APRILTAG_'+family[3:]))


def _number(target, key, low, high, integer=False):
    value=target.get(key)
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high or (integer and type(value) is not int):
        raise ValueError('标定板参数无效：'+key)
    return value


def validate_target(target):
    if not isinstance(target,dict):raise ValueError('请选择标定板类型')
    kind=target.get('type')
    if kind=='registered':
        validate_boards([target.get('board')])
    elif kind=='aprilgrid':
        rows=_number(target,'rows',2,12,True);cols=_number(target,'columns',2,12,True)
        _number(target,'tagSizeMm',3,200);_number(target,'gapMm',.1,200)
        mode=target.get('layoutMode','manual')
        if mode not in ('auto','manual'):raise ValueError('编号识别方式无效')
        first=_number(target,'firstId',0,2319,True) if mode=='manual' else 0
        family=target.get('family')
        if family not in ('auto',)+FAMILIES or target.get('idOrder','row-major') not in ('row-major','column-major'):
            raise ValueError('标定板码族或编号排列无效')
        if first+rows*cols>(2320 if family=='auto' else len(dictionary(family).bytesList)):
            raise ValueError('码族编号数量不足以组成此标定板')
    elif kind=='checkerboard':
        _number(target,'rows',3,20,True);_number(target,'columns',3,20,True)
        _number(target,'squareSizeMm',1,200)
    else:raise ValueError('不支持的标定板类型')
    return target


def grid_points(target, marker_id):
    index=marker_id-target['firstId'];rows,cols=target['rows'],target['columns']
    if not 0<=index<rows*cols:raise ValueError('码ID不属于标定板')
    if target.get('idOrder','row-major')=='column-major':col,row=divmod(index,rows)
    else:row,col=divmod(index,cols)
    side=target['tagSizeMm']/1000;pitch=(target['tagSizeMm']+target['gapMm'])/1000
    offsets=np.array([[-side/2,side/2,0],[side/2,side/2,0],[side/2,-side/2,0],[-side/2,-side/2,0]])
    return offsets+[col*pitch,-row*pitch,0]


def grid_correspondences(target, detections):
    """由整板几何校验四种角点起点，支持外购板的不同规范方向。

    至少四个码跨两行两列才能消除方向歧义；不靠图像中的左上角排序。
    """
    ids=sorted(i for i in detections if target['firstId']<=i<target['firstId']+target['rows']*target['columns'])
    if len(ids)<4:return None,'至少需要4个完整子码',None
    centers=np.array([grid_points(target,i).mean(axis=0) for i in ids])
    if len(np.unique(centers[:,0]))<2 or len(np.unique(centers[:,1]))<2:
        return None,'可见子码需分布在至少两行、两列',None
    obj=np.concatenate([grid_points(target,i) for i in ids]);solutions=[]
    for shift in range(4):
        px=np.concatenate([np.roll(detections[i],shift,axis=0) for i in ids]).astype(np.float64)
        if not np.all(np.isfinite(px)):continue
        h,_=cv2.findHomography(obj[:,:2],px)
        if h is None:continue
        projected=cv2.perspectiveTransform(obj[:,:2].reshape(-1,1,2),h).reshape(-1,2)
        rms=float(np.sqrt(np.mean(np.sum((px-projected)**2,axis=1))))
        if math.isfinite(rms):solutions.append((rms,shift,px))
    solutions.sort(key=lambda s:s[0])
    if len(solutions)<2:return None,'角点几何不能求解',None
    error,shift,px=solutions[0]
    edge=float(np.median([np.linalg.norm(p-np.roll(p,-1,axis=0),axis=1).mean() for i,p in detections.items() if i in ids]))
    if error>max(2.5,edge*.08):return None,'码间距、编号排列或板面不匹配，请核对参数',None
    if solutions[1][0]-error<max(1.,error*.2):return None,'板方向存在歧义，请露出更多分散的子码',None
    return (obj,px,ids),'可用于标定',{'cornerShift':shift,'planarRmsPixels':error}


def auto_grid_correspondences(target, detections):
    """从单帧平面格点确定相对几何，不要求码ID连续或看到板的边缘。

    内参标定每帧独立求板外参，原点可选任意可见码。以解码角点建立局部
    平面，再按实测中心距对格点求整板对应；该相对原点不用于导航地图。
    """
    ids=sorted(detections)
    if len(ids)<4:return None,'至少需要4个完整子码',None
    if len(ids)>target['rows']*target['columns']:return None,'可见码数超过板规格，请移开其他标记',None
    observed=np.array([detections[i] for i in ids],dtype=np.float64)
    if not np.all(np.isfinite(observed)):return None,'角点数据无效',None
    side=target['tagSizeMm']/1000;pitch=(target['tagSizeMm']+target['gapMm'])/1000
    offsets=np.array([[-side/2,side/2],[side/2,side/2],[side/2,-side/2],[-side/2,-side/2]])
    areas=np.array([abs(cv2.contourArea(p.astype(np.float32))) for p in observed])
    centers=observed.mean(axis=1);middle=centers.mean(axis=0)
    anchors=np.argsort(np.linalg.norm(centers-middle,axis=1)/np.sqrt(np.maximum(areas,1)))[:min(6,len(ids))]
    edge=float(np.median(np.linalg.norm(observed-np.roll(observed,-1,axis=1),axis=2)))
    solutions=[]
    for anchor in anchors:
        h,_=cv2.findHomography(offsets,observed[anchor])
        if h is None:continue
        try:inverse=np.linalg.inv(h)
        except np.linalg.LinAlgError:continue
        local=cv2.perspectiveTransform(observed.reshape(-1,1,2),inverse).reshape(-1,4,2)
        if not np.all(np.isfinite(local)):continue
        cells=np.rint(local.mean(axis=1)/pitch).astype(np.int64)
        if np.max(np.linalg.norm(local.mean(axis=1)-cells*pitch,axis=1))>pitch*.22:continue
        if len(set(map(tuple,cells)))!=len(ids):continue
        if len(np.unique(cells[:,0]))<2 or len(np.unique(cells[:,1]))<2:continue
        span=np.ptp(cells,axis=0)+1;dimensions=np.array([target['columns'],target['rows']])
        if not (np.all(span<=dimensions) or np.all(span<=dimensions[::-1])):continue
        obj2=cells[:,None,:]*pitch+offsets
        reordered=[]
        for measured,position,points in zip(local,obj2,observed):
            shift=min(range(4),key=lambda k:float(np.sum((np.roll(measured,k,axis=0)-position)**2)))
            reordered.append(np.roll(points,shift,axis=0))
        px=np.concatenate(reordered);obj2=obj2.reshape(-1,2)
        fitted,_=cv2.findHomography(obj2,px)
        if fitted is None:continue
        projected=cv2.perspectiveTransform(obj2.reshape(-1,1,2),fitted).reshape(-1,2)
        rms=float(np.sqrt(np.mean(np.sum((px-projected)**2,axis=1))))
        if not math.isfinite(rms) or rms>max(2.5,edge*.08):continue
        obj=np.column_stack((obj2,np.zeros(len(obj2))))
        layout=[{'id':i,'column':int(c[0]),'row':int(c[1])} for i,c in zip(ids,cells)]
        solutions.append((rms,obj,px,layout))
    if not solutions:return None,'无法匹配规则阵列，请露出两行两列以上的码并核对尺寸/间距',None
    rms,obj,px,layout=min(solutions,key=lambda item:item[0])
    return (obj,px,ids),'编号和相对布局已自动识别',{'layoutMode':'auto','observedCells':layout,'planarRmsPixels':rms}


def detect_target(gray, target):
    validate_target(target)
    kind=target['type'];details={'valid':False,'matchedCount':0,'detectedIds':[]}
    if kind=='checkerboard':
        cols,rows=target['columns'],target['rows']
        ok,px=cv2.findChessboardCornersSB(gray,(cols,rows),flags=cv2.CALIB_CB_NORMALIZE_IMAGE)
        if not ok:return None,{**details,'reason':'未找到完整棋盘格内角点'}
        obj=np.zeros((rows*cols,3),np.float64)
        obj[:,:2]=np.mgrid[0:cols,0:rows].T.reshape(-1,2)*target['squareSizeMm']/1000
        return (obj,px.reshape(-1,2)),{**details,'valid':True,'matchedCount':len(obj),'reason':'已识别完整棋盘格'}
    families=('tag36h11',) if kind=='registered' else (FAMILIES if target['family']=='auto' else (target['family'],))
    candidates=[];best={**details,'reason':'未识别到匹配标定板的码族或编号'}
    parameters=cv2.aruco.DetectorParameters_create()
    parameters.cornerRefinementMethod=cv2.aruco.CORNER_REFINE_SUBPIX
    # 专用AprilGrid的反色/连通背景结构需要允许反色候选。
    # 不使用CORNER_REFINE_APRILTAG：OpenCV4.5.4该组合在实帧会段错误。
    parameters.detectInvertedMarker=kind=='aprilgrid'
    for family in families:
        dic=dictionary(family)
        automatic=kind=='aprilgrid' and target.get('layoutMode','manual')=='auto'
        if kind=='aprilgrid' and (0 if automatic else target['firstId'])+target['rows']*target['columns']>len(dic.bytesList):continue
        corners,ids,_=cv2.aruco.detectMarkers(gray,dic,parameters=parameters)
        if ids is None:continue
        refinement_window=5
        if kind=='aprilgrid':
            measured=np.asarray(corners).reshape(-1,4,2)
            side_pixels=float(np.median(np.linalg.norm(measured-np.roll(measured,-1,axis=1),axis=2)))
            refinement_window=max(3,min(11,int(round(side_pixels*.075))))
            if refinement_window%2==0:refinement_window+=1
            if refinement_window!=parameters.cornerRefinementWinSize:
                parameters.cornerRefinementWinSize=refinement_window
                parameters.cornerRefinementMaxIterations=50
                parameters.cornerRefinementMinAccuracy=.01
                corners,ids,_=cv2.aruco.detectMarkers(gray,dic,parameters=parameters)
                if ids is None:continue
        flat=ids.ravel().tolist()
        if len(flat)!=len(set(flat)):
            best={**details,'reason':'画面存在重复ID，请移开其他标定板'}
            continue
        detections={int(i):np.asarray(c).reshape(4,2) for i,c in zip(flat,corners)}
        if kind=='registered':
            match=board_correspondences(target['board'],printed_marker_detections(ids,corners))
            count=0 if match is None else len(match[2])
            valid=match is not None and count>=min(4,len(target['board']['members']))
            answer=None if not valid else (match[0],match[1])
            reason='可用于标定' if valid else '未识别到足够的已登记子码'
            extra={}
        else:
            match,reason,extra=(auto_grid_correspondences if automatic else grid_correspondences)(target,detections)
            count=len(flat) if automatic else sum(target['firstId']<=i<target['firstId']+target['rows']*target['columns'] for i in flat)
            answer=None if match is None else (match[0],match[1]);valid=answer is not None
        diag={**details,'valid':valid,'family':family,'matchedCount':count,'detectedIds':sorted(flat),'reason':reason,'invertedDetectionEnabled':parameters.detectInvertedMarker,'cornerRefinementWindow':refinement_window,**(extra or {})}
        if count>=best['matchedCount']:best=diag
        if valid:candidates.append((answer,diag))
    if len(candidates)>1:return None,{**details,'reason':'码族识别有歧义，请手动选择板上的码族'}
    return candidates[0] if candidates else (None,best)
