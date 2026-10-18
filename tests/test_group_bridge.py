"""离线调用回调验证多码数据流，不构造ROS节点、不发布底盘指令。"""
import json
import sys
import queue
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/greenhouse_navigation'))
from greenhouse_navigation.node import GreenhouseNode

def board():
    return {'id':'B000','referenceId':0,'gridSize':2,'sizeMm':140,'gapMm':2,'members':[{'id':i,'x':(-.0355 if i%2==0 else .0355),'y':(.0355 if i<2 else -.0355),'angle':0,'size':.0552} for i in range(4)]}

class BridgeChecks(unittest.TestCase):
    def harness(self):
        self.logs=[]
        return SimpleNamespace(active_boards=[board()],mission=SimpleNamespace(running=False,field=None,log=self.logs.append),get_clock=lambda:SimpleNamespace(now=lambda:SimpleNamespace(nanoseconds=10_000_000_000)),observations=[],camera_received=0.,tag_received=0.,tag_sigma=float('inf'),survey=queue.Queue())

    def packet(self):
        return {'frame':'base_link','stamp':10,'calibrated':True,'synchronized':True,'representation':'board-centers','groupLayouts':[board()],'localPoseSynchronized':True,'localPose':{'x':0,'y':0,'yaw':0},'tags':[{'id':0,'groupId':'B000','memberIds':[2],'visibleCount':1,'x':.1,'y':.2,'angle':0,'sigma':.02,'angleSigma':.04,'size':.14}]}

    def test_surviving_non_reference_member_is_one_logical_node(self):
        h=self.harness();GreenhouseNode.observation_cb(h,SimpleNamespace(data=json.dumps(self.packet())))
        self.assertEqual(h.observations[0]['id'],0);self.assertEqual(h.observations[0]['memberIds'],[2]);self.assertGreaterEqual(h.observations[0]['sigma'],.02);self.assertLess(h.observations[0]['sigma'],.03)
        sample=h.survey.get_nowait();self.assertEqual(sample['representation'],'board-centers');self.assertEqual(sample['groupLayouts'],[board()]);self.assertEqual(sample['tags'][0]['x'],.1)

    def test_inconsistent_print_layout_not_used_for_position(self):
        h=self.harness();p=self.packet();p['groupLayouts'][0]['sizeMm']=150
        GreenhouseNode.observation_cb(h,SimpleNamespace(data=json.dumps(p)))
        self.assertEqual(h.observations,[]);self.assertEqual(h.tag_received,0.);self.assertTrue(h.survey.empty());self.assertTrue(self.logs)

if __name__=='__main__':unittest.main(verbosity=2)
