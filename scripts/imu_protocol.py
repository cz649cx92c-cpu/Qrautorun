"""Bounded Yahboom 7e23 receive parser. Protocol supplied by the owner.
No I/O, device writes, orientation synthesis or device-model guesses.
"""
from dataclasses import dataclass
import math
import struct
from collections import Counter

# Workbook factor; math import is above. Not a chip register scale.
GYRO_RAD_S_PER_LSB=(2000/32767.)*(math.pi/180.)

@dataclass(frozen=True)
class Frame:
    kind: int
    values: tuple
    received_at: float
    acceleration: tuple = ()
    angular_velocity: tuple = ()
    @property
    def fields(self):
        if self.kind==4:return dict(zip(('accel_raw','gyro_raw','mag_raw'),(self.values[:3],self.values[3:6],self.values[6:9])))
        names={22:('w','x','y','z'),38:('roll_rad','pitch_rad','yaw_rad'),50:('height_m','temperature_c','pressure_pa','startup_reference_pa')}
        return dict(zip(names[self.kind],self.values))

class Parser:
    LENGTHS = {0x04:23,0x16:21,0x26:17,0x32:21}
    def __init__(self,max_age=.25):
        self.max_age=max_age
        self.buffer=bytearray()
        self.times=[]
        self.counts=Counter()
        self.errors=Counter()
    def clear(self):
        self.buffer.clear();self.times.clear()
    def discard(self,n):
        del self.buffer[:n];del self.times[:n]
    def feed(self,data,received_at,now=None):
        if now is None:now=received_at
        if not all(math.isfinite(v) for v in (received_at,now)) or not 0<=now-received_at<=self.max_age:
            self.errors['stale']+=1;self.clear();return []
        if self.times and not 0<=now-self.times[0]<=self.max_age:
            self.errors['stale']+=1;self.clear()
        result=[]
        for offset in range(0,len(data),64):
            part=data[offset:offset+64]
            self.buffer.extend(part);self.times.extend([received_at]*len(part))
            while self.buffer:
                start=self.buffer.find(b'\x7e\x23')
                if start<0:
                    keep=1 if self.buffer[-1]==0x7e else 0
                    self.errors['noise_bytes']+=len(self.buffer)-keep
                    self.discard(len(self.buffer)-keep);break
                if start:self.errors['noise_bytes']+=start;self.discard(start)
                if len(self.buffer)<4:break
                length,kind=self.buffer[2:4]
                if not 5<=length<=64 or kind not in self.LENGTHS or length!=self.LENGTHS[kind]:
                    self.errors['length_or_type']+=1;self.discard(1);continue
                if len(self.buffer)<length:break
                raw=bytes(self.buffer[:length]);observed=self.times[0]
                if sum(raw[:-1])&255!=raw[-1]:
                    self.errors['checksum']+=1;self.discard(1);continue
                self.discard(length)
                if not 0<=now-observed<=self.max_age:self.errors['stale']+=1;continue
                values=struct.unpack('<9h' if kind==4 else '<'+('f'*((length-5)//4)),raw[4:-1])
                if not all(math.isfinite(v) for v in values):self.errors['nonfinite']+=1;continue
                self.counts[kind]+=1
                acceleration=tuple(v*(16/32767.)*9.80665 for v in values[:3]) if kind==4 else ()
                gyro=tuple(v*GYRO_RAD_S_PER_LSB for v in values[3:6]) if kind==4 else ()
                result.append(Frame(kind,values,observed,acceleration,gyro))
        return result
