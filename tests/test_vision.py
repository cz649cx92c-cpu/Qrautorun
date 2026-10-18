"""投影几何/标定退化检查；不作为相机实测精度证据。"""
import math
import json
from pathlib import Path
import sys
import unittest
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.vision import marker_corners,board_correspondences,solve_board_pose,camera_parameters,printed_marker_detections,calibration_board_diagnostic
from greenhouse_navigation.calibration import calibrate_views
from greenhouse_navigation.camera_handoff import legacy_preview_matches


def board():
    tile=.0235
    return {'id':'B016','referenceId':16,'gridSize':4,'sizeMm':100,'gapMm':2,
            'members':[{'id':16+i,'x':(i%4-1.5)*.0255,'y':(1.5-i//4)*.0255,
                        'angle':0.,'size':tile/1.25} for i in range(16)]}


class VisionTests(unittest.TestCase):
    def test_dedicated_board_diagnostic_never_creates_navigation_observation(self):
        image=cv2.imread(str(ROOT/'tests/fixtures/aprilgrid-nir.jpg'),cv2.IMREAD_GRAYSCALE)
        target={'type':'aprilgrid','family':'tag36h11','rows':6,'columns':6,
                'tagSizeMm':22,'gapMm':6.6,'layoutMode':'auto'}
        result=calibration_board_diagnostic(image,target)
        self.assertIsNotNone(result)
        self.assertGreaterEqual(result['matchedCount'],4)
        self.assertFalse(result['navigationObservation'])
        self.assertFalse(any(key in result for key in ('x','y','angle','tags','groupId','members')))
        wrong={**target,'gapMm':20}
        self.assertIsNone(calibration_board_diagnostic(image,wrong))
        self.assertIsNone(calibration_board_diagnostic(image,{'type':'registered'}))
        self.assertIsNone(calibration_board_diagnostic(np.full_like(image,255),target))

    def test_all_printed_ids_match_opencv_with_half_turn(self):
        family=json.loads((ROOT/'web/assets/tag36h11.json').read_text())
        dictionary=cv2.aruco.Dictionary_get(cv2.aruco.DICT_APRILTAG_36h11)
        for identifier,code in enumerate(family['codes']):
            cells=np.zeros((10,10),np.uint8)
            cells[0,:]=cells[-1,:]=cells[:,0]=cells[:,-1]=255
            for bit in range(36):
                if int(code,16)&(1<<(35-bit)):
                    cells[family['bitY'][bit]+1,family['bitX'][bit]+1]=255
            reference=cv2.aruco.drawMarker(dictionary,identifier,8)
            self.assertTrue(np.array_equal(np.rot90(cells[1:9,1:9],2),reference),identifier)
        # 实际像素检测也必须恢复打印方向；不能只测试理想投影角点。
        marker=np.rot90(cv2.aruco.drawMarker(dictionary,16,160),2)
        image=np.full((240,240),255,np.uint8);image[40:200,40:200]=marker
        corners,ids,_=cv2.aruco.detectMarkers(image,dictionary)
        points=printed_marker_detections(ids,corners)[16]
        np.testing.assert_allclose(points,[[40,40],[199,40],[199,199],[40,199]],atol=1)
        self.assertEqual(printed_marker_detections(None,[]),{})

    def setUp(self):
        self.board=board();self.k=np.array([[700.,0.,640.],[0.,720.,360.],[0.,0.,1.]])
        self.d=np.zeros(5);self.rotation=np.array([[0.,-1.,0.],[-1.,0.,0.],[0.,0.,-1.]])
        self.translation=np.array([0.,0.,.14]);yaw=.3
        base_rotation=np.array([[math.cos(yaw),-math.sin(yaw),0.],[math.sin(yaw),math.cos(yaw),0.],[0.,0.,1.]])
        rvec=cv2.Rodrigues(self.rotation.T@base_rotation)[0]
        tvec=self.rotation.T@(np.array([.03,.05,0.])-self.translation)
        self.detections={m['id']:cv2.projectPoints(marker_corners(m),rvec,tvec,self.k,self.d)[0].reshape(4,2) for m in self.board['members']}

    def solve(self,detections):
        return solve_board_pose(self.board,detections,self.k,self.d,self.rotation,self.translation)

    def test_entire_board_pose_and_heading(self):
        result=self.solve(self.detections)
        self.assertIsNotNone(result)
        self.assertEqual(result['visibleCount'],16)
        self.assertAlmostEqual(result['x'],.03,places=6)
        self.assertAlmostEqual(result['y'],.05,places=6)
        self.assertAlmostEqual(result['angle'],.3,places=6)

    def test_missing_reference_tag_still_recovers_board_center(self):
        full=self.solve(self.detections)
        result=self.solve({29:self.detections[29]})
        self.assertIsNotNone(result)
        self.assertEqual(result['id'],16)
        self.assertEqual(result['memberIds'],[29])
        self.assertAlmostEqual(result['x'],.03,places=6)
        self.assertAlmostEqual(result['y'],.05,places=6)
        self.assertGreater(result['sigma'],full['sigma'])

    def test_bad_member_is_removed(self):
        detections={k:v.copy() for k,v in self.detections.items()}
        detections[22]+=[20.,-25.]
        result=self.solve(detections)
        self.assertIsNotNone(result)
        self.assertIn(22,result['rejectedMemberIds'])
        self.assertAlmostEqual(result['x'],.03,places=5)

    def test_wrong_installation_and_nonfinite_corners_rejected(self):
        result=solve_board_pose(self.board,self.detections,self.k,self.d,np.eye(3),self.translation)
        self.assertIsNone(result)
        self.assertIsNone(self.solve({16:np.full((4,2),np.nan)}))

    def test_intrinsics_must_match_real_capture_resolution(self):
        data={'cameraMatrix':self.k.tolist(),'distortion':self.d.tolist(),'width':1280,'height':720}
        camera_parameters(data,1280,720)
        with self.assertRaises(ValueError):camera_parameters(data,640,480)
        data['cameraMatrix'][0][0]=0
        with self.assertRaises(ValueError):camera_parameters(data,1280,720)

    def views(self,tilted=True):
        obj=np.concatenate([marker_corners(m) for m in self.board['members']])
        objects=[];pixels=[]
        for i in range(20):
            rvec=np.array([(.45*math.sin(i*1.1) if tilted else 0.),(.4*math.cos(i*.9) if tilted else 0.),.15*math.sin(i)])
            tvec=np.array([.08*math.sin(i*.8),.06*math.cos(i*1.3),.3+.03*math.sin(i)])
            pixels.append(cv2.projectPoints(obj,rvec,tvec,self.k,self.d)[0].reshape(-1,2))
            objects.append(obj.copy())
        return objects,pixels

    def test_distinct_tilts_produce_valid_intrinsics_with_holdout(self):
        objects,pixels=self.views()
        result=calibrate_views(objects,pixels,(1280,720))
        self.assertTrue(result['calibrationVerified'])
        self.assertEqual(result['trainingCount'],15)
        self.assertEqual(result['validationCount'],5)
        self.assertLess(result['rmsPixels'],.001)
        self.assertAlmostEqual(result['cameraMatrix'][0][0],700.,delta=.1)

    def test_flat_board_translation_is_not_camera_calibration(self):
        objects,pixels=self.views(False)
        with self.assertRaisesRegex(ValueError,'倾角变化不足'):
            calibrate_views(objects,pixels,(1280,720))

    def test_too_few_views_not_accepted(self):
        objects,pixels=self.views()
        with self.assertRaisesRegex(ValueError,'16张'):
            calibrate_views(objects[:10],pixels[:10],(1280,720))

    def test_camera_handoff_never_targets_chassis_or_other_camera(self):
        topic='/autorun_final/uvc_preview/compressed'
        command=['/usr/bin/python3','/home/orangepi/ugv/autorunlida/uvc_preview_publisher.py',
                 '--source','/dev/video0','--image-topic',topic]
        self.assertTrue(legacy_preview_matches(command,'/dev/video0',topic))
        self.assertFalse(legacy_preview_matches(command,'/dev/video2',topic))
        self.assertFalse(legacy_preview_matches(command,'/dev/video0','/other/topic'))
        bad=command.copy();bad[1]='/home/orangepi/ugv/autorunlida/app_web.py'
        self.assertFalse(legacy_preview_matches(bad,'/dev/video0',topic))
        self.assertFalse(legacy_preview_matches(['/some/yhs_can_control_node'],'/dev/video0',topic))
        self.assertFalse(legacy_preview_matches(command+['--source','/dev/video2'],'/dev/video0',topic))


if __name__=='__main__':unittest.main(verbosity=2)
