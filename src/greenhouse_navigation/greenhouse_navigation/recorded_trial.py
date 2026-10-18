"""User-authorized low-speed taught-route trial; not a mechanical calibration."""
import json,math
from pathlib import Path
LIMITS=json.loads(Path(__file__).with_name('recorded_trial_limits.json').read_text())
if LIMITS.get('profile')!='recorded_slow_trial' or any(not isinstance(v,(int,float)) or not math.isfinite(v) or v<=0 for k,v in LIMITS.items() if k!='profile'):
    raise ValueError('Invalid recorded route trial limits')
def limits_for(profile):
    return LIMITS if profile==LIMITS['profile'] else None
