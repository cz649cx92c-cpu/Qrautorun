"""Exercise the deployed Web worker offline, without importing ROS or opening sockets."""
import ast
import copy
import io
import json
import queue
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import Request


SOURCE=Path(__file__).resolve().parents[1]/'src/greenhouse_navigation/greenhouse_navigation/node.py'


def actual_web_worker(namespace):
    """Compile only the real method: no ROS constructor, publishers, or CAN imports."""
    module=ast.parse(SOURCE.read_text(encoding='utf-8'))
    cls=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='GreenhouseNode')
    method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='web_worker')
    extracted=ast.Module(body=[method],type_ignores=[])
    exec(compile(ast.fix_missing_locations(extracted),str(SOURCE),'exec'),namespace)
    return namespace['web_worker']


class BridgeSnapshotTests(unittest.TestCase):
    def run_worker(self, snapshots, fail_first=False):
        telemetry=[];acks=[];polls=[];attempts=[];warnings=[]
        snapshots=copy.deepcopy(snapshots)
        with tempfile.TemporaryDirectory() as directory:
            key=Path(directory)/'config/bridge.key';key.parent.mkdir();key.write_text('offline-only-key')
            node=SimpleNamespace(config={'backend_url':'http://offline.invalid','bridge_key_file':str(key)},
                                 snapshot=snapshots[0],lock=threading.Lock(),commands=queue.Queue(),
                                 acks=queue.Queue(),survey=queue.Queue(),motion_records=queue.Queue(),mission=SimpleNamespace(running=False),
                                 get_logger=lambda:SimpleNamespace(warning=warnings.append))
            node.acks.put({'id':'ack-0','ok':True})

            class Closed:
                iteration=0
                def is_set(self):return self.iteration>=len(snapshots)
                def wait(self, timeout):
                    self.iteration+=1
                    if not self.is_set():
                        node.snapshot=snapshots[self.iteration]
                        node.acks.put({'id':'ack-'+str(self.iteration),'ok':True})
                    return self.is_set()

            node.closed=Closed()
            def opened(request,timeout):
                path=request.full_url[len('http://offline.invalid'):]
                payload=json.loads(request.data) if request.data else None
                if path=='/api/robot/telemetry':
                    attempts.append(payload)
                    if fail_first and len(attempts)==1:
                        raise HTTPError(request.full_url,400,'injected rejection',{},io.BytesIO(b'{}'))
                    telemetry.append(payload);result={'ok':True}
                elif path=='/api/robot/commands':
                    polls.append(node.closed.iteration);result=[{'id':'same-command','type':'stop','payload':{}}]
                elif path=='/api/robot/ack':acks.append(payload);result={'ok':True}
                elif path=='/api/boards':result=[]
                else:raise AssertionError('Unexpected request '+path)
                return io.BytesIO(json.dumps(result).encode())

            opener=Mock();opener.open.side_effect=opened
            namespace={'copy':copy,'json':json,'time':SimpleNamespace(monotonic=lambda:100.,time=lambda:100.),
                       'uuid':uuid,'Path':Path,'Request':Request,'build_opener':lambda _:opener,
                       'ProxyHandler':lambda _:None,'validate_boards':lambda boards:boards}
            actual_web_worker(namespace)(node)
            log_path=Path(directory)/'logs/navigation.jsonl'
            records=[json.loads(l) for l in log_path.read_text().splitlines()] if log_path.exists() else []
            return SimpleNamespace(telemetry=telemetry,attempts=attempts,acks=acks,polls=polls,
                                   commands=list(node.commands.queue),warnings=warnings,records=records)

    def test_unchanged_snapshot_is_not_reposted_but_commands_and_acks_continue(self):
        snapshot={'bootId':'boot-a','seq':10}
        result=self.run_worker([snapshot,snapshot,snapshot,snapshot])
        self.assertEqual(len(result.telemetry),1)
        self.assertEqual(len(result.records),1)
        self.assertEqual(result.polls,[0,1,2,3])
        self.assertEqual(len(result.acks),4)
        self.assertEqual(len(result.commands),1,'Repeated command IDs must still be deduplicated')
        self.assertEqual(result.warnings,[])

    def test_new_sequence_or_new_boot_is_uploaded_once(self):
        result=self.run_worker([{'bootId':'a','seq':1},{'bootId':'a','seq':1},
                                {'bootId':'a','seq':2},{'bootId':'b','seq':2}])
        self.assertEqual([(x['bootId'],x['seq']) for x in result.telemetry],[('a',1),('a',2),('b',2)])
        self.assertEqual(len(result.polls),4)

    def test_rejected_snapshot_is_retried_before_it_is_marked_sent(self):
        snapshot={'bootId':'boot-a','seq':10}
        result=self.run_worker([snapshot,snapshot,snapshot],fail_first=True)
        self.assertEqual(len(result.attempts),2)
        self.assertEqual(len(result.telemetry),1)
        self.assertEqual(len(result.records),1)
        self.assertEqual(result.polls,[1,2])
        self.assertEqual(len(result.acks),3)
        self.assertEqual(len(result.warnings),1)


if __name__=='__main__':unittest.main(verbosity=2)
