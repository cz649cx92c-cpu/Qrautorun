"""米制多码板位姿：OpenCV原生PnP，整组共同估计，不依赖首个子码存活。"""
import math
import cv2
import numpy as np
from .board_geometry import validate_boards


def calibration_board_diagnostic(gray, target):
    """仅检查当前画面是否匹配专用标定目标，不返回导航位姿或布局。

    专用板可能与导航打印板重号，诊断中的角点和ID不能送入导航PnP。
    """
    if not isinstance(target, dict) or target.get('type') != 'aprilgrid':
        return None
    from .calibration_target import detect_target
    _, details = detect_target(gray, target)
    if details.get('valid') is not True:
        return None
    return {'type':'aprilgrid', 'matchedCount':details['matchedCount'],
            'detectedIds':details['detectedIds'], 'navigationObservation':False}


def printed_marker_detections(ids, corners):
    """将OpenCV的36h11角点转为本项目官方AprilTag打印图案的角点顺序。

    两个字典对同一ID的规范图案相差180度；ID相同不代表角点起点相同。
    只重排每个子码的角点，不旋转板中心或改变已打印的地图几何。
    """
    if ids is None:
        return {}
    return {int(i): np.roll(np.asarray(c).reshape(4, 2), 2, axis=0)
            for i, c in zip(np.asarray(ids).ravel(), corners)}


def marker_corners(member):
    size = member['size']
    corners = np.array([[-size/2, size/2, 0.], [size/2, size/2, 0.],
                        [size/2, -size/2, 0.], [-size/2, -size/2, 0.]])
    angle = member['angle']
    c, s = math.cos(angle), math.sin(angle)
    rotation = np.array([[c,-s,0.], [s,c,0.], [0.,0.,1.]])
    return corners @ rotation.T + [member['x'], member['y'], 0.]


def board_correspondences(board, detections):
    validate_boards([board])
    objects, pixels, members = [], [], []
    for member in board['members']:
        if member['id'] not in detections:
            continue
        points = np.asarray(detections[member['id']], dtype=float).reshape(4,2)
        if not np.all(np.isfinite(points)):
            continue
        objects.append(marker_corners(member))
        pixels.append(points)
        members.append(member['id'])
    if not members:
        return None
    return np.concatenate(objects), np.concatenate(pixels), members


def camera_parameters(data, width=None, height=None):
    """只接受实测内参，不自动猜焦距或缩放到另一采集模式。"""
    k = np.asarray(data['cameraMatrix'], dtype=float)
    d = np.asarray(data['distortion'], dtype=float).ravel()
    if (k.shape != (3,3) or len(d) not in (4,5,8,12,14) or not np.all(np.isfinite(k))
            or not np.all(np.isfinite(d)) or k[0,0] <= 0 or k[1,1] <= 0
            or not np.allclose(k[2], [0.,0.,1.]) or abs(k[0,1])+abs(k[1,0]) > 1e-6):
        raise ValueError('相机内参格式或数值无效')
    if width is not None and (data['width'] != width or data['height'] != height):
        raise ValueError('当前采集规格与内参标定规格不一致')
    return k, d


def solve_board_pose(board, detections, k, d, rotation, translation,
                     max_reprojection=1.5, max_distance=1., max_ground_height=.08):
    correspondence = board_correspondences(board, detections)
    if correspondence is None:
        return None
    objects, pixels, ids = correspondence
    detected_count = len(ids)
    rotation = np.asarray(rotation, dtype=float).reshape(3,3)
    translation = np.asarray(translation, dtype=float).reshape(3)
    k = np.asarray(k, dtype=float).reshape(3,3)
    if not all(np.all(np.isfinite(v)) for v in (rotation, translation, k, d)):
        return None
    # 多子码RANSAC剔除角点污染，随后仅用完整保留的子码求整板平面解。
    if len(ids) > 1:
        ok, _, _, inliers = cv2.solvePnPRansac(objects, pixels, k, d,
            iterationsCount=100, reprojectionError=max(2., max_reprojection*2),
            confidence=.99, flags=cv2.SOLVEPNP_EPNP)
        if not ok or inliers is None:
            return None
        good = set(inliers.ravel().tolist())
        retained = [i for i in range(len(ids)) if all(i*4+j in good for j in range(4))]
        if not retained or len(retained) <= len(ids)/2:
            return None
        indices = np.array([i*4+j for i in retained for j in range(4)])
        objects, pixels = objects[indices], pixels[indices]
        ids = [ids[i] for i in retained]
    # OpenCV4.5的IPPE在朝下相机的接近180度旋转处会出现NaN。
    # 先在反向法线的平面基底求解，再把旋转变换回打印板坐标系。
    plane_basis=np.diag([1.,-1.,-1.])
    ok, raw_rvecs, tvecs, _ = cv2.solvePnPGeneric(objects @ plane_basis, pixels, k, d, flags=cv2.SOLVEPNP_IPPE)
    rvecs=[];translations=[]
    if ok:
        for r,t in zip(raw_rvecs,tvecs):
            if np.all(np.isfinite(r)) and np.all(np.isfinite(t)):
                rvecs.append(cv2.Rodrigues(cv2.Rodrigues(r)[0] @ plane_basis)[0]);translations.append(t)
    # 迭代解提供同一组实际角点的独立数值回退，仍受重投影/地面法向/歧义门限约束。
    iterative_ok, iterative_r, iterative_t=cv2.solvePnP(objects,pixels,k,d,flags=cv2.SOLVEPNP_ITERATIVE)
    if iterative_ok:
        rvecs.append(iterative_r);translations.append(iterative_t)
    candidates = []
    for rvec, tvec in zip(rvecs,translations):
        if not np.all(np.isfinite(rvec)) or not np.all(np.isfinite(tvec)):
            continue
        r_camera_board = cv2.Rodrigues(rvec)[0]
        if np.min((objects @ r_camera_board.T+tvec.ravel())[:,2]) <= 0:
            continue
        projected, jacobian = cv2.projectPoints(objects, rvec, tvec, k, d)
        if not np.all(np.isfinite(projected)) or not np.all(np.isfinite(jacobian)):
            continue
        rms = float(np.sqrt(np.mean(np.sum((projected.reshape(-1,2)-pixels)**2, axis=1))))
        base_rotation = rotation @ r_camera_board
        base_center = rotation @ tvec.ravel()+translation
        if (rms > max_reprojection or np.linalg.norm(base_center)>max_distance
                or abs(base_center[2])>max_ground_height or base_rotation[2,2]<.95):
            continue
        yaw = math.atan2(base_rotation[1,0],base_rotation[0,0])
        candidates.append((rms, base_center, yaw, rvec, tvec, jacobian))
    if not candidates:
        return None
    candidates.sort(key=lambda item:item[0])
    best = candidates[0]
    if len(candidates)>1:
        alternate = candidates[1]
        yaw_difference = math.atan2(math.sin(best[2]-alternate[2]),math.cos(best[2]-alternate[2]))
        if alternate[0] <= max(best[0]*1.15, best[0]+.1) and (
                np.linalg.norm(best[1][:2]-alternate[1][:2])>.02 or abs(yaw_difference)>.1):
            return None
    error, point, yaw, rvec, tvec, jacobian = best
    pixel_noise = max(.5,error)
    j = jacobian[:,:6]
    covariance = np.linalg.pinv(j.T @ j)*pixel_noise**2
    base_covariance = rotation @ covariance[3:6,3:6] @ rotation.T
    position_sigma = math.sqrt(max(0.,float(np.linalg.eigvalsh(base_covariance[:2,:2])[-1])))
    yaw_gradient = []
    for axis in range(3):
        perturbed = rvec.copy();perturbed[axis,0] += 1e-6
        r = rotation @ cv2.Rodrigues(perturbed)[0]
        angle = math.atan2(r[1,0],r[0,0])
        yaw_gradient.append(math.atan2(math.sin(angle-yaw), math.cos(angle-yaw))/1e-6)
    yaw_gradient = np.array(yaw_gradient)
    yaw_sigma = math.sqrt(max(0.,float(yaw_gradient @ covariance[:3,:3] @ yaw_gradient)))
    penalty = math.sqrt(len(board['members'])/len(ids))
    if len(ids)==1:
        penalty = max(1.5,penalty)
    return {'id':board['referenceId'], 'groupId':board['id'], 'memberIds':ids,
            'visibleCount':len(ids), 'detectedCount':detected_count,
            'rejectedMemberIds':sorted(set(correspondence[2])-set(ids)),
            'x':float(point[0]), 'y':float(point[1]), 'angle':yaw,
            'sigma':max(.01*penalty,position_sigma), 'angleSigma':max(.02*penalty,yaw_sigma),
            'size':board['sizeMm']/1000, 'reprojectionPx':error}
