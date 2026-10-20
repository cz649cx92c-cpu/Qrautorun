import math,statistics,collections
from imu_protocol import GYRO_RAD_S_PER_LSB
def code_bins(rows):
 if not rows or any(len(r)!=3 or not all(math.isfinite(v) for v in r) for r in rows):raise ValueError('finite 3-axis samples required')
 raw=[[round(v/GYRO_RAD_S_PER_LSB) for v in r] for r in rows]
 return {'provenance':'inverse from ROS SI, not direct serial recapture','oneLsbRadS':GYRO_RAD_S_PER_LSB,
 'maxRoundTripError':max(abs(v-c*GYRO_RAD_S_PER_LSB) for r,b in zip(rows,raw) for v,c in zip(r,b)),
 'axes':[{'codes':{str(k):v for k,v in sorted(collections.Counter(r[a] for r in raw).items())},'stdRadS':statistics.pstdev(r[a] for r in rows)} for a in range(3)],
 'hardwareFaultEstablished':False,'unresolved':['vibration/mounting','intrinsic noise/warm-up','firmware output/deadband']}
