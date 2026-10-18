"""多码板数学单元检查：无摄像头、ROS 节点或底盘运动。"""
import copy
import math
from pathlib import Path
import sys
import unittest

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'src/greenhouse_navigation'))
from greenhouse_navigation.board_geometry import collapse_group_observations,validated_board_observations,validate_boards,same_board_layout,member_to_board


def board(n=2,start=0,size_mm=100):
    gap=2;tile=(size_mm-(n-1)*gap)/n/1000
    return {'id':f'B{start:03d}','referenceId':start,'gridSize':n,'sizeMm':size_mm,'gapMm':gap,
            'members':[{'id':start+i,'x':(i%n-(n-1)/2)*(tile+gap/1000),
                        'y':((n-1)/2-i//n)*(tile+gap/1000),'angle':0.,'size':tile/1.25} for i in range(n*n)]}


def observe(member,center=(1.,-.3,.6),sigma=.01):
    x,y,a=center;c,s=math.cos(a),math.sin(a)
    return {'id':member['id'],'x':x+c*member['x']-s*member['y'],
            'y':y+s*member['x']+c*member['y'],'angle':a+member['angle'],'sigma':sigma}


class BoardChecks(unittest.TestCase):
    def test_each_surviving_member_same_board_center(self):
        layout=board()
        for m in layout['members']:
            output=collapse_group_observations([observe(m)],[layout])
            self.assertEqual(len(output),1)
            t=output[0];self.assertEqual(t['id'],0);self.assertEqual(t['memberIds'],[m['id']])
            self.assertAlmostEqual(t['x'],1.);self.assertAlmostEqual(t['y'],-.3);self.assertAlmostEqual(t['angle'],.6)
            self.assertGreaterEqual(t['sigma'],.015)

    def test_partial_four_by_four(self):
        layout=board(4,40,160)
        tags=[observe(layout['members'][i]) for i in [1,7,12]]
        result=collapse_group_observations(tags,[layout])[0]
        self.assertEqual(result['visibleCount'],3);self.assertEqual(result['memberIds'],[41,47,52])
        self.assertAlmostEqual(result['x'],1.);self.assertGreater(result['sigma'],.01)

    def test_full_board_uncertainty_not_artificially_reduced(self):
        layout=board(4,100)
        result=collapse_group_observations([observe(m) for m in layout['members']],[layout])[0]
        self.assertGreaterEqual(result['sigma'],.01)
        self.assertEqual(result['visibleCount'],16)

    def test_rotated_member_and_base_frame(self):
        layout=board()
        # base/camera外参旋转后观测已在base_link；板中心恢复不能丢失旋转。
        for angle in [-math.pi+.01,-1.2,math.pi-.01]:
            t=collapse_group_observations([observe(layout['members'][2],(-.4,.8,angle))],[layout])[0]
            self.assertAlmostEqual(t['x'],-.4);self.assertAlmostEqual(t['y'],.8);self.assertAlmostEqual(t['angle'],angle)
        # 刚体变换函数本身也支持旋转偏移；目前已注册打印布局固定子码angle=0。
        member=dict(layout['members'][2]);member['angle']=math.pi/2
        t=member_to_board(observe(member,(-.4,.8,-1.2)),member)
        self.assertAlmostEqual(t['x'],-.4);self.assertAlmostEqual(t['y'],.8);self.assertAlmostEqual(t['angle'],-1.2)

    def test_two_conflicting_members_rejected(self):
        layout=board();tags=[observe(layout['members'][0]),observe(layout['members'][1],(1.2,-.3,.6))]
        self.assertEqual(collapse_group_observations(tags,[layout]),[])
        tags=[observe(layout['members'][0]),observe(layout['members'][1],(1.,-.3,1.))]
        self.assertEqual(collapse_group_observations(tags,[layout]),[])

    def test_outlier_rejected_by_unique_majority(self):
        layout=board();tags=[observe(m) for m in layout['members']]
        tags[-1]['x']+=.2
        t=collapse_group_observations(tags,[layout])[0]
        self.assertEqual(t['visibleCount'],3);self.assertEqual(t['rejectedMemberIds'],[3]);self.assertAlmostEqual(t['x'],1.)

    def test_two_boards_never_combined(self):
        a,b=board(2,0),board(2,4)
        tags=[observe(a['members'][0]),observe(b['members'][1],(3.,4.,-.5))]
        result=collapse_group_observations(tags,[a,b])
        self.assertEqual({t['groupId'] for t in result},{'B000','B004'})
        self.assertEqual({t['id'] for t in result},{0,4})

    def test_single_marker_compatibility_and_no_fabrication(self):
        tag={'id':586,'x':.2,'y':.1,'angle':0.,'sigma':.02}
        self.assertEqual(collapse_group_observations([tag],[board()]),[tag])
        self.assertEqual(collapse_group_observations([],[board()]),[])

    def test_board_center_is_not_transformed_twice(self):
        layout=board();tag=collapse_group_observations([observe(layout['members'][3])],[layout])[0]
        t=validated_board_observations([tag],[layout],[layout])[0]
        self.assertEqual(t['x'],tag['x']);self.assertEqual(t['y'],tag['y'])
        t['memberIds']=[400]
        self.assertEqual(validated_board_observations([t],[layout],[layout]),[])

    def test_stale_geometry_snapshot_rejected(self):
        layout=board();tag=collapse_group_observations([observe(layout['members'][0])],[layout])[0]
        old=board(size_mm=120)
        self.assertFalse(same_board_layout(layout,old))
        self.assertEqual(validated_board_observations([tag],[layout],[old]),[])
        self.assertEqual(validated_board_observations([tag],[layout],[]),[])

    def test_invalid_and_duplicate_layouts(self):
        a=board()
        with self.assertRaises(ValueError):validate_boards([a,a])
        a=board();a['members'][1]['size']*=1.25
        with self.assertRaises(ValueError):validate_boards([a])
        a=board();a['members'][0]['x']=float('nan')
        with self.assertRaises(ValueError):validate_boards([a])

    def test_print_contract_is_strict(self):
        for field,value in [('sizeMm',19),('sizeMm',181),('gapMm',0),('gapMm',3),('id','wrong'),('referenceId',True)]:
            a=board();a[field]=value
            with self.subTest(field=field,value=value):
                with self.assertRaises(ValueError):validate_boards([a])
        a=board();a['members'][1]['id']=22
        with self.assertRaises(ValueError):validate_boards([a])
        a=board();a['members'][1]['angle']=math.pi/2
        with self.assertRaises(ValueError):validate_boards([a])
        with self.assertRaises(ValueError):validate_boards([board(4,0,20)])
        # 实际子码黑边下界10mm；每组外宽也必须服从同一打印物理关系。
        self.assertEqual(len(validate_boards([board(4,0,56)])),1)

    def test_duplicate_frames_do_not_inflate_visibility(self):
        layout=board();tag=observe(layout['members'][0])
        result=collapse_group_observations([tag,copy.deepcopy(tag)],[layout])[0]
        self.assertEqual(result['visibleCount'],1)


if __name__=='__main__':unittest.main(verbosity=2)
