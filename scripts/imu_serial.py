"""Receive-only serial lifecycle. No calibration/reset/frequency/command bytes."""
import copy
import fcntl
import termios
from imu_protocol import Parser

DEFAULT_PORT='/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0'

def open_passive_port(port,baud):
    import serial
    class PassivePort(serial.Serial):
        original=None
        def _reconfigure_port(self,force_update=False):
            if self.original is None:
                fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                fcntl.ioctl(self.fd,termios.TIOCEXCL)
                self.original=copy.deepcopy(termios.tcgetattr(self.fd))
            try:return super()._reconfigure_port(force_update)
            except BaseException:
                termios.tcsetattr(self.fd,termios.TCSANOW,self.original)
                raise
        def write(self,*args,**kwargs):raise RuntimeError('Serial payload writes are forbidden')
        def send_break(self,*args,**kwargs):raise RuntimeError('Serial break is forbidden')
        def close(self):
            if self.is_open and self.original is not None:
                try:termios.tcsetattr(self.fd,termios.TCSANOW,self.original)
                finally:
                    try:fcntl.ioctl(self.fd,termios.TIOCNXCL)
                    finally:super().close()
            else:super().close()
    p=PassivePort(port=None,baudrate=baud,timeout=0,exclusive=True,rtscts=False,dsrdtr=False,xonxoff=False)
    p.dtr=False;p.rts=False;p.port=port
    p.open()
    return p

class Receiver:
    def __init__(self,port=DEFAULT_PORT,baud=115200,max_age=.25,reconnect_s=1.,max_backlog=512,factory=open_passive_port):
        if baud!=115200 or not .01<=max_age<=.25 or reconnect_s<.1 or not 64<=max_backlog<=512:
            raise ValueError('Invalid verified serial/freshness settings')
        self.port=port;self.baud=baud;self.max_age=max_age;self.reconnect_s=reconnect_s;self.max_backlog=max_backlog
        self.factory=factory;self.parser=Parser(max_age);self.serial=None;self.next_attempt=0.;self.last_poll=None
        self.error='';self.connections=0;self.disconnects=0;self.dropped_backlog=0;self.dropped_stale=0
    @property
    def connected(self):return self.serial is not None
    def close(self):
        p,self.serial=self.serial,None
        self.parser.clear();self.last_poll=None
        if p is not None:p.close()
    def poll(self,now):
        try:
            if self.serial is None:
                if now<self.next_attempt:return []
                self.next_attempt=now+self.reconnect_s
                self.serial=self.factory(self.port,self.baud)
                # Flush only the host RX queue; this sends no device command.
                self.serial.reset_input_buffer();self.parser.clear()
                self.connections+=1;self.error='';self.last_poll=now
                return []
            gap=now-self.last_poll;self.last_poll=now
            if not 0<=gap<=self.max_age:
                self.serial.reset_input_buffer();self.parser.clear();self.dropped_stale+=1;return []
            waiting=self.serial.in_waiting
            if waiting>self.max_backlog:
                self.serial.reset_input_buffer();self.parser.clear();self.dropped_backlog+=1;return []
            if not waiting:return []
            data=self.serial.read(min(waiting,self.max_backlog))
            return [f for f in self.parser.feed(data,now) if f.kind==4]
        except (OSError,ValueError,RuntimeError) as error:
            self.error=type(error).__name__+': '+str(error);self.disconnects+=1
            try:self.close()
            except OSError:pass
            self.next_attempt=now+self.reconnect_s
            return []
