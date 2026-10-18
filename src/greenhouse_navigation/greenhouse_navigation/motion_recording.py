"""Read-only teaching feedback recording, including marker-free intervals."""
import math

def feedback_record(msg, seq, epoch, received, existing=True):
    ctrl=msg.ctrl_fb
    values=[float(ctrl.ctrl_fb_x_linear),float(ctrl.ctrl_fb_y_linear),float(ctrl.ctrl_fb_z_angular)]
    if not all(math.isfinite(v) for v in values):return None
    return {'stamp':msg.header.stamp.sec+msg.header.stamp.nanosec/1e9,
            'seq':seq,'receivedMonotonic':received,'localEpoch':epoch or '',
            'bodyGear':int(ctrl.ctrl_fb_gear),'steeringGear':int(msg.steering_ctrl_fb.steering_ctrl_fb_gear),
            'vx':values[0],'vyRaw':values[1],'vy':values[1]*(.1 if existing else 1.),
            'wz':math.radians(values[2]),'feedbackSource':'chassis_info_fb_aggregate'}
