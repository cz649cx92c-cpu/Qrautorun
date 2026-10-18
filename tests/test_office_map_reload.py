import json,tempfile,unittest
from pathlib import Path
from collections import deque
from types import SimpleNamespace as NS
import test_static_localization
from greenhouse_navigation.localization import GlobalLocalization
class MapReloadTests(unittest.TestCase):
 def test_new_map_clears_old_origin_without_faking_pose(self):
  field=json.loads(Path('/tmp/office3-generated.json').read_text())['map'];field['coordinateStatus']='reviewed'
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'map.json';p.write_text(json.dumps({'map':field,'version':2}));errors=[]
   n=NS(map_path=p,map_content='old',field={'id':'old'},estimate=[1,2,3],formal_origin=True,formal_published_at=1.,formal_preview_at=1.,history=deque([1]),pending_static=deque([1]),last_odometry=object(),get_parameter=lambda k:NS(value=.25 if k=='max_observation_age_s' else .2),get_logger=lambda:NS(info=lambda s:None,error=errors.append))
   GlobalLocalization.reload_map(n);self.assertEqual(n.field['id'],field['id']);self.assertEqual(n.map_version,2);self.assertIsNone(n.estimate);self.assertFalse(n.formal_origin);self.assertEqual(len(n.history),0);self.assertEqual(len(n.pending_static),0);self.assertIsNone(n.last_odometry)
   n.estimate=[4,5,6];GlobalLocalization.reload_map(n);self.assertEqual(n.estimate,[4,5,6])
   p.write_text('{broken');GlobalLocalization.reload_map(n);self.assertEqual(n.estimate,[4,5,6]);self.assertTrue(errors)
if __name__=='__main__':unittest.main()
