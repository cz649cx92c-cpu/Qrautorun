#!/usr/bin/env python3
"""真实同步观测离线优化：运动增量+标记重复观测+已知基准点；不用首次里程计冒充真实坐标。"""
import json,sys,math
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix


def wrap(a):return np.arctan2(np.sin(a),np.cos(a))


def optimize(data):
    samples=data['samples']
    if not 3<=len(samples)<=500:raise ValueError('每次优化需要3–500组同步观测；大采集请分段处理')
    ids=sorted({o['id'] for s in samples for o in s['tags']})
    if not ids:raise ValueError('采集中没有有效标记')
    n=len(samples);indices={id:i for i,id in enumerate(ids)}
    odom=np.array([[s['pose']['x'],s['pose']['y'],s['pose']['yaw']] for s in samples],float)
    first=odom[0].copy()
    c,s=math.cos(first[2]),math.sin(first[2]);rotation=np.array([[c,s],[-s,c]])
    initial=odom.copy();initial[:,:2]=(odom[:,:2]-first[:2])@rotation.T;initial[:,2]=wrap(odom[:,2]-first[2])
    observations={id:[] for id in ids}
    for i,sample in enumerate(samples):
        yaw=initial[i,2];r=np.array([[math.cos(yaw),-math.sin(yaw)],[math.sin(yaw),math.cos(yaw)]])
        for tag in sample['tags']:observations[tag['id']].append(initial[i,:2]+r@np.array([tag['x'],tag['y']]))
    tags=np.array([np.mean(observations[id],axis=0) for id in ids])
    anchors=data.get('anchors',[])
    known=[a for a in anchors if a['id'] in indices]
    # 至少两基准点时用刚体配准设置世界坐标；不允许缩放地图掩盖里程计误差。
    if len(known)>=2:
        src=np.array([tags[indices[a['id']]] for a in known]);dst=np.array([[a['x'],a['y']] for a in known]);sc=src.mean(0);dc=dst.mean(0)
        u,_,vt=np.linalg.svd((src-sc).T@(dst-dc));r=vt.T@u.T
        if np.linalg.det(r)<0:vt[-1]*=-1;r=vt.T@u.T
        delta=math.atan2(r[1,0],r[0,0]);initial[:,:2]=(initial[:,:2]-sc)@r.T+dc;initial[:,2]=wrap(initial[:,2]+delta);tags=(tags-sc)@r.T+dc
    elif len(known)==1:
        a=known[0];delta=np.array([a['x'],a['y']])-tags[indices[a['id']]];initial[:,:2]+=delta;tags+=delta
    x0=np.concatenate([initial.ravel(),tags.ravel()])
    # Precompute invariant observations. Keep the residual order and weights intact.
    odom_delta=np.diff(odom[:,:2],axis=0)
    oc,os=np.cos(odom[:-1,2]),np.sin(odom[:-1,2])
    delta=np.column_stack((oc*odom_delta[:,0]+os*odom_delta[:,1],-os*odom_delta[:,0]+oc*odom_delta[:,1]))
    dyaw=wrap(np.diff(odom[:,2]));motion_sigma=np.maximum(.015,.03*np.linalg.norm(delta,axis=1))
    flat=[(i,indices[t['id']],t['x'],t['y'],max(.005,float(t.get('sigma',.02)))) for i,sample in enumerate(samples) for t in sample['tags']]
    obs=np.asarray(flat,float);obs_pose=obs[:,0].astype(int);obs_landmark=obs[:,1].astype(int)
    obs_xy=obs[:,2:4];obs_sigma=obs[:,4,None]
    anchor_ids=np.array([indices[a['id']] for a in known],dtype=int)
    anchor_xy=np.array([[a['x'],a['y']] for a in known],float).reshape(-1,2)
    def residual(x):
        poses=x[:3*n].reshape(n,3);landmarks=x[3*n:].reshape(-1,2)
        difference=np.diff(poses[:,:2],axis=0);c,s=np.cos(poses[:-1,2]),np.sin(poses[:-1,2])
        predicted=np.column_stack((c*difference[:,0]+s*difference[:,1],-s*difference[:,0]+c*difference[:,1]))
        motion=np.column_stack(((predicted-delta)/motion_sigma[:,None],wrap(np.diff(poses[:,2])-dyaw)/.03))
        p=poses[obs_pose];c,s=np.cos(p[:,2]),np.sin(p[:,2])
        predicted=p[:,:2]+np.column_stack((c*obs_xy[:,0]-s*obs_xy[:,1],s*obs_xy[:,0]+c*obs_xy[:,1]))
        observations=(predicted-landmarks[obs_landmark])/obs_sigma
        anchors=(landmarks[anchor_ids]-anchor_xy)/.005
        gauge=(poses[0]-initial[0])/.0001 if not known else np.array([wrap(poses[0,2]-initial[0,2])/.0001]) if len(known)==1 else np.empty(0)
        return np.concatenate((motion.ravel(),observations.ravel(),anchors.ravel(),gauge))
    m=3*(n-1)+2*sum(len(s['tags']) for s in samples)+2*len(known)+(3 if not known else 1 if len(known)==1 else 0)
    sparsity=lil_matrix((m,len(x0)),dtype=int);k=0
    for i in range(1,n):sparsity[k:k+3,3*(i-1):3*(i+1)]=1;k+=3
    for i,sample in enumerate(samples):
        for tag in sample['tags']:
            sparsity[k:k+2,3*i:3*i+3]=1;j=3*n+2*indices[tag['id']];sparsity[k:k+2,j:j+2]=1;k+=2
    for a in known:
        j=3*n+2*indices[a['id']];sparsity[k:k+2,j:j+2]=1;k+=2
    if not known:sparsity[k:k+3,:3]=1
    elif len(known)==1:sparsity[k,2]=1
    result=least_squares(residual,x0,loss='soft_l1',f_scale=1.,max_nfev=600,jac_sparsity=sparsity.tocsr(),x_scale='jac',
                         tr_options={'atol':1e-10,'btol':1e-10,'maxiter':1500})
    if not result.success:
        reason='达到计算次数上限' if result.status==0 else '求解器未完成计算'
        raise ValueError(f'地图优化{reason}，尚未收敛；扫描记录已保留，可补扫或添加实测基准点后重试')
    poses=result.x[:3*n].reshape(n,3);tags=result.x[3*n:].reshape(-1,2);stats=[]
    for id in ids:
        errors=[];angles=[]
        for i,sample in enumerate(samples):
            p=poses[i];r=np.array([[math.cos(p[2]),-math.sin(p[2])],[math.sin(p[2]),math.cos(p[2])]])
            for t in sample['tags']:
                if t['id']==id:
                    errors.append(np.linalg.norm(p[:2]+r@np.array([t['x'],t['y']])-tags[indices[id]]));angles.append(wrap(p[2]+float(t.get('angle',0.))))
        stats.append({'id':id,'x':float(tags[indices[id],0]),'y':float(tags[indices[id],1]),'angle':float(math.degrees(math.atan2(np.mean(np.sin(angles)),np.mean(np.cos(angles))))),'count':len(errors),'residualM':float(np.sqrt(np.mean(np.square(errors)))),'repeated':len(errors)>=3})
    return {'tags':stats,'poses':poses.tolist(),'anchored':len(known)>=2,'coordinateStatus':'draft','rmsM':float(np.sqrt(np.mean([s['residualM']**2 for s in stats]))),'note':'重复观测优化结果仍需实测坐标验收；少于两个基准点时世界方向未充分约束。'}

if __name__=='__main__':
    try:print(json.dumps(optimize(json.load(sys.stdin)),ensure_ascii=False))
    except Exception as e:print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
