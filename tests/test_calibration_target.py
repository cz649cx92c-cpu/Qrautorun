"""专用板像素检测和几何测试；图像为独立测试数据，不代表实物标定结果。"""
import json
import contextlib
import io
import math
import subprocess
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src/greenhouse_navigation'))
from greenhouse_navigation.calibration_target import detect_target, grid_points, grid_correspondences, auto_grid_correspondences, validate_target, dictionary
from greenhouse_navigation.calibration import calibrate_views


def target(family='tag36h11'):
    return dict(type='aprilgrid',family=family,rows=6,columns=6,tagSizeMm=20.,gapMm=5.,firstId=0,idOrder='row-major')


def image_for(t,turn=0,visible=None):
    image=np.full((720,1280),255,np.uint8)
    for i in range(t['rows']*t['columns']):
        if visible is not None and i not in visible:continue
        row,col=divmod(i,t['columns'])
        x,y=400+col*80,110+row*80
        image[y:y+64,x:x+64]=np.rot90(cv2.aruco.drawMarker(dictionary(t['family']),i+t['firstId'],64),turn)
    return image


class DedicatedTargetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cv2.setNumThreads(2)

    def test_six_by_six_pixels_and_canonical_turns(self):
        t=target()
        for turn in range(4):
            with self.subTest(turn=turn):
                points,detail=detect_target(image_for(t,turn),t)
                self.assertTrue(detail['valid'],detail)
                self.assertEqual(detail['matchedCount'],36)
                self.assertEqual(points[0].shape,(144,3))
                self.assertLess(detail['planarRmsPixels'],.1)

    def test_actual_nir_aprilgrid_inverted_candidates_and_outer_corners(self):
        gray=cv2.imread(str(ROOT/'tests/fixtures/aprilgrid-nir.jpg'),0)
        self.assertIsNotNone(gray)
        t={**target(),'layoutMode':'auto','family':'auto','tagSizeMm':22,'gapMm':6.4}
        points,detail=detect_target(gray,t)
        self.assertTrue(detail['valid'],detail)
        self.assertEqual(detail['family'],'tag36h11')
        self.assertGreaterEqual(detail['matchedCount'],12)
        self.assertTrue(detail['invertedDetectionEnabled'])
        self.assertEqual(detail['cornerRefinementWindow'],9)
        self.assertLess(detail['planarRmsPixels'],3.)
        self.assertEqual(len(points[0]),detail['matchedCount']*4)

    def test_auto_family_and_partial_visibility(self):
        for family in ('tag36h11','tag36h10'):
            t=target(family);points,detail=detect_target(image_for(t,2,[0,5,30,35]),{**t,'family':'auto'})
            self.assertTrue(detail['valid'],detail);self.assertEqual(detail['family'],family)
            self.assertEqual(detail['matchedCount'],4);self.assertEqual(len(points[0]),16)

    def test_unlabelled_arbitrary_ids_and_partial_board(self):
        t={**target(),'layoutMode':'auto','family':'auto'}
        for visible in (list(range(36)),[7,8,13,14],[0,5,30,35]):
            image=np.full((720,1280),255,np.uint8);expected=[]
            for index in visible:
                identifier=500-index*11;expected.append(identifier)
                row,col=divmod(index,6);x,y=400+col*80,110+row*80
                image[y:y+64,x:x+64]=np.rot90(cv2.aruco.drawMarker(dictionary('tag36h11'),identifier,64),index%4)
            points,detail=detect_target(image,t)
            self.assertTrue(detail['valid'],detail);self.assertEqual(detail['detectedIds'],sorted(expected))
            self.assertEqual(detail['matchedCount'],len(visible));self.assertEqual(len(points[0]),len(visible)*4)
            self.assertEqual(len(detail['observedCells']),len(visible))

    def test_auto_layout_rejects_wrong_grid_geometry(self):
        t={**target(),'layoutMode':'auto'}
        raw={500-i*11:grid_points(target(),i)[:,:2]*5000+[640,500] for i in range(36)}
        self.assertIsNone(auto_grid_correspondences({**t,'gapMm':20},raw)[0])
        self.assertIsNone(auto_grid_correspondences(t,{k:v for k,v in list(raw.items())[:6]})[0])
        self.assertIsNone(auto_grid_correspondences({**t,'rows':2,'columns':2},raw)[0])

    def test_wrong_spacing_and_insufficient_spread_rejected(self):
        t=target();detections={i:grid_points(t,i)[:,:2]*5000+[640,500] for i in range(36)}
        self.assertIsNone(grid_correspondences({**t,'gapMm':20},detections)[0])
        self.assertIsNone(grid_correspondences(t,{i:detections[i] for i in range(6)})[0])
        self.assertIsNone(detect_target(np.full((720,1280),255,np.uint8),t)[0])

    def test_family_capacity_and_millimetres(self):
        with self.assertRaises(ValueError):validate_target(target('tag25h9'))
        with self.assertRaises(ValueError):validate_target({**target(),'rows':True})
        np.testing.assert_allclose(grid_points(target(),35).mean(axis=0),[.125,-.125,0])
        np.testing.assert_allclose(grid_points({**target(),'idOrder':'column-major'},5).mean(axis=0),[0,-.125,0])

    def test_checkerboard_internal_corners(self):
        image=np.full((600,800),255,np.uint8)
        for r in range(6):
            for c in range(6):
                if (r+c)%2==0:image[100+r*60:160+r*60,180+c*60:240+c*60]=0
        points,detail=detect_target(image,dict(type='checkerboard',columns=5,rows=5,squareSizeMm=20))
        self.assertTrue(detail['valid'],detail);self.assertEqual(detail['matchedCount'],25)
        self.assertAlmostEqual(points[0][-1,0],.08)

    def test_probe_and_failed_session_do_not_write_intrinsics(self):
        t=target();jpeg=cv2.imencode('.jpg',image_for(t))[1].tobytes()
        result=subprocess.run(['/usr/bin/python3',str(ROOT/'scripts/probe_calibration_target.py'),json.dumps(t)],input=jpeg,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)['result']['matchedCount'],36)
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);name='frame-000.jpg';(folder/name).write_bytes(jpeg)
            (folder/'session.json').write_text(json.dumps(dict(target=t,samples=[{'file':name}],createdAt='test',physicalScaleConfirmed=True)))
            output=folder/'intrinsics.json';output.write_text('existing-calibration')
            run=subprocess.run(['/usr/bin/python3',str(ROOT/'scripts/calibrate_tag_board.py'),str(folder),'--output',str(output)],capture_output=True,timeout=10)
            self.assertEqual(run.returncode,1);self.assertIn('有效照片1/1',json.loads(run.stdout)['error'])
            self.assertEqual(output.read_text(),'existing-calibration');self.assertTrue((folder/'analysis.json').exists())

    def test_valid_multiview_session_solves_and_saves_measured_intrinsics(self):
        t=target();template=image_for(t,2)
        source=np.float32([[400,110],[864,110],[864,574],[400,574]])
        obj=np.float64([[-.01,.01,0],[.135,.01,0],[.135,-.135,0],[-.01,-.135,0]])
        k=np.float64([[700,0,640],[0,720,360],[0,0,1]])
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);samples=[]
            for i in range(20):
                rotation=cv2.Rodrigues(np.float64([.45*math.sin(i*1.1),.4*math.cos(i*.9),.15*math.sin(i)]))[0]@np.diag([1.,-1.,-1.])
                translation=np.float64([-.0625+.065*math.sin(i*.8),.0625+.05*math.cos(i*1.3),.3+.03*math.sin(i)])
                destination=cv2.projectPoints(obj,cv2.Rodrigues(rotation)[0],translation,k,np.zeros(5))[0].reshape(-1,2).astype(np.float32)
                h=cv2.getPerspectiveTransform(source,destination)
                image=cv2.warpPerspective(template,h,(1280,720),borderValue=255)
                name=f'frame-{i:03d}.jpg';cv2.imwrite(str(folder/name),image);samples.append({'file':name})
            (folder/'session.json').write_text(json.dumps(dict(target={**t,'family':'auto','layoutMode':'auto'},samples=samples,createdAt='test',physicalScaleConfirmed=True)))
            output=folder/'intrinsics.json'
            run=subprocess.run(['/usr/bin/python3',str(ROOT/'scripts/calibrate_tag_board.py'),str(folder),'--output',str(output)],capture_output=True,timeout=45)
            self.assertEqual(run.returncode,0,run.stdout.decode()+run.stderr.decode())
            measured=json.loads(output.read_text());self.assertTrue(measured['calibrationVerified'])
            self.assertEqual(measured['target']['family'],'tag36h11');self.assertGreaterEqual(measured['validationCount'],4)
            self.assertAlmostEqual(measured['cameraMatrix'][0][0],700,delta=15)
            analysis=json.loads((folder/'analysis.json').read_text())
            review=json.loads((folder/'review.json').read_text())
            self.assertEqual(review['files'],[s['file'] for s in samples])
            self.assertEqual(sum('reprojection' in a for a in analysis),len(measured['images']))
            self.assertTrue(all(not a['reprojection']['excessive'] for a in analysis if 'reprojection' in a))

    def test_failed_fit_keeps_per_photo_residuals_and_validation_roles(self):
        obj=np.float32([[x*.025,y*.025,0] for y in range(6) for x in range(6)])
        k=np.float64([[700,0,640],[0,720,360],[0,0,1]])
        objects=[];pixels=[];rng=np.random.default_rng(42)
        for i in range(20):
            r=np.float64([.45*math.sin(i*1.1),.4*math.cos(i*.9),.15*math.sin(i)])
            t=np.float64([-.0625+.065*math.sin(i*.8),-.0625+.05*math.cos(i*1.3),.3+.03*math.sin(i)])
            px=cv2.projectPoints(obj,r,t,k,np.zeros(5))[0].reshape(-1,2)
            if i==8:px+=rng.normal(0,5,px.shape)
            objects.append(obj.copy());pixels.append(px)
        report={}
        with self.assertRaisesRegex(ValueError,'标定误差过大'):
            calibrate_views(objects,pixels,(1280,720),report)
        self.assertEqual(len(report['perView']),20)
        self.assertEqual(report['perView'][8]['role'],'training')
        self.assertGreater(report['perView'][8]['rmsPixels'],4)
        self.assertTrue(report['perView'][8]['excessive'])
        self.assertEqual(report['perView'][3]['role'],'validation')
        self.assertEqual(report['perView'][3]['thresholdPixels'],1.2)
        self.assertGreater(report['rmsPixels'],.8)
        self.assertLess(report['validationMaxPixels'],1.2)

    def test_rejected_solver_persists_review_without_overwriting_intrinsics(self):
        def rejected(objects,pixels,size,diagnostics):
            diagnostics.update(rmsPixels=1.55,validationMaxPixels=.23,trainingThresholdPixels=.8,
                               validationThresholdPixels=1.2,perView=[dict(index=9,role='training',rmsPixels=6.46,thresholdPixels=.8,excessive=True)])
            raise ValueError('标定误差过大：拟合1.55px，独立验证最大0.23px')
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);samples=[]
            for i in range(16):
                name=f'frame-{i:03d}.jpg';cv2.imwrite(str(folder/name),np.full((720,1280),255,np.uint8));samples.append({'file':name})
            (folder/'session.json').write_text(json.dumps(dict(target=target(),samples=samples,createdAt='test',physicalScaleConfirmed=True)))
            output=folder/'intrinsics.json';output.write_text('existing-passed-calibration')
            stream=io.StringIO();obj=np.float32([[0,0,0],[1,0,0],[1,1,0],[0,1,0]])
            with patch.object(sys,'argv',[str(ROOT/'scripts/calibrate_tag_board.py'),str(folder),'--output',str(output)]),\
                 patch('greenhouse_navigation.calibration_target.detect_target',return_value=((obj,obj[:,:2]),{'valid':True,'family':'tag36h11','matchedCount':4})),\
                 patch('greenhouse_navigation.calibration.calibrate_views',side_effect=rejected),contextlib.redirect_stdout(stream):
                with self.assertRaises(SystemExit) as error:runpy.run_path(str(ROOT/'scripts/calibrate_tag_board.py'),run_name='__main__')
            self.assertEqual(error.exception.code,1);self.assertFalse(json.loads(stream.getvalue())['ok'])
            self.assertEqual(output.read_text(),'existing-passed-calibration')
            analysis=json.loads((folder/'analysis.json').read_text());review=json.loads((folder/'review.json').read_text())
            self.assertEqual(analysis[9]['reprojection']['rmsPixels'],6.46)
            self.assertTrue(analysis[9]['reprojection']['excessive']);self.assertEqual(review['files'],[s['file'] for s in samples])


if __name__=='__main__':unittest.main(verbosity=2)
