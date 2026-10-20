"""Serial source provenance and connection identity; no hardware or ROS I/O."""
import math

class SerialSourceHealth:
    def __init__(self,timeout=2.5):
        self.timeout=timeout;self.last_at=None;self.identity=None;self.received=None;self.valid=False
    def fresh(self,now):
        return self.valid and self.last_at is not None and 0<=now-self.last_at<=self.timeout
    def observe(self,status,now):
        if not isinstance(status,dict) or not math.isfinite(now):self.valid=False;return False,False
        valid=(status.get('source')=='Yahboom serial' and status.get('protocol')=='7e23-sum8'
               and status.get('port')=='/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'
               and status.get('baud')==115200 and status.get('connected') is True and status.get('online') is True
               and status.get('payloadBytesSent')==0
               and all(type(status.get(k)) is int and status[k]>=0 for k in ['connections','disconnects','received']))
        if not valid:self.valid=False;return False,False
        identity=(status['source'],status['port'],status['baud'],status['connections'],status['disconnects'])
        changed=self.identity is not None and (identity!=self.identity or status['received']<self.received or not self.fresh(now))
        self.identity=identity;self.received=status['received'];self.last_at=now;self.valid=True
        return True,changed
