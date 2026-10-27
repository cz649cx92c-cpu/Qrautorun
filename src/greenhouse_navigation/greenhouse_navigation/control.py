"""独立前进、倒车与四轮横移路径跟踪。输出车体速度/角速度，不实现电机通信。"""
from dataclasses import dataclass
import math
from .recorded_trial import limits_for


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


# 末段停车的唯一制动度量。速度规划(recorded_speed_plan)、速度限幅(limit)与
# 区间执行(END_STOP 判据)都必须用同一组函数，禁止再出现各自的硬编码死区。
def max_speed_for_distance(distance, braking):
    """在给定可用距离内以 braking 减速可达到的最大速度。"""
    room = max(0., float(distance))
    rate = max(1e-9, float(braking))
    return math.sqrt(2. * rate * room)


def brake_stop_distance(speed, braking, delay=0.):
    """从 speed 起以 braking 减速、并计入 delay 指令时延的停车距离。"""
    v = abs(float(speed or 0.))
    rate = max(1e-9, float(braking or 0.))
    hold = max(0., float(delay or 0.))
    return v * v / (2. * rate) + v * hold


def endpoint_brake_metrics(speed, remaining, braking, delay=0.):
    """末段制动的结构化度量（诊断/决策共用，不参与任何伪造速度）。

    ``predictedBrakeM`` 是含指令时延的总预测停车距离
    （v^2/(2b) + v*delay）；``velocityDelayMarginM`` 是其中时延贡献的部分。
    """
    v = abs(float(speed or 0.))
    rate = max(1e-9, float(braking or 0.))
    hold = max(0., float(delay or 0.))
    left = float(remaining or 0.)
    margin = v * hold
    brake = v * v / (2. * rate)
    predicted = margin + brake
    return {'vx': v, 'brakingMps2': rate,
            'velocityDelayMarginM': margin, 'predictedBrakeM': predicted,
            'pureBrakeM': brake, 'remainingM': left,
            'predictedStopErrorM': left - predicted}


def endpoint_brake_speed(remaining, braking, delay=0.):
    """按同一度量给出「此刻仍可在目标点停住」的最大速度。

    解 v^2/(2b) + v*delay = remaining 的正根：v = -b*delay + sqrt((b*delay)^2 + 2*b*remaining)。
    """
    room = max(0., float(remaining or 0.))
    rate = max(1e-9, float(braking or 0.))
    hold = max(0., float(delay or 0.))
    return max(0., -rate * hold + math.sqrt((rate * hold) ** 2 + 2. * rate * room))


@dataclass
class Pose:
    x: float
    y: float
    yaw: float
    sigma: float = float('inf')
    stamp: float = 0.0


@dataclass
class Command:
    mode: str = '4t4d'
    vx: float = 0.0
    vy: float = 0.0
    yaw_rate: float = 0.0
    wheel_angle: float = 0.0


def geometry(pose, points, include_curvature=False):
    if len(points) < 2:
        raise ValueError('路线至少需要两个点')
    candidates = []
    lengths = [math.hypot(b['x']-a['x'], b['y']-a['y']) for a, b in zip(points, points[1:])]
    for i, (a, b) in enumerate(zip(points, points[1:])):
        length = lengths[i]
        if length < 0.001:
            raise ValueError('路线控制点重合')
        ux, uy = (b['x']-a['x'])/length, (b['y']-a['y'])/length
        projection = (pose.x-a['x'])*ux + (pose.y-a['y'])*uy
        t = max(0., min(length, projection))
        x, y = a['x']+ux*t, a['y']+uy*t
        candidates.append((math.hypot(pose.x-x,pose.y-y), i, x, y, ux, uy, t))
    _, i, x, y, ux, uy, t = min(candidates)
    cross = -uy*(pose.x-x)+ux*(pose.y-y)
    remaining = lengths[i]-t+sum(lengths[i+1:])
    result = (cross, math.atan2(uy,ux), remaining,
              math.hypot(pose.x-points[-1]['x'],pose.y-points[-1]['y']))
    if not include_curvature:
        return result
    return (*result, path_curvatures(points, lengths)[i])


def path_curvatures(points, lengths):
    """Use the same adjacent-segment geometry for tracking and speed planning."""
    tangents = [math.atan2(b['y']-a['y'], b['x']-a['x']) for a,b in zip(points,points[1:])]
    curvatures = []
    for i in range(len(lengths)):
        left, right = max(0,i-1), min(len(lengths)-1,i+1)
        span = sum(lengths[left:right+1])-.5*(lengths[left]+lengths[right])
        curvatures.append(wrap(tangents[right]-tangents[left])/span if span>.001 else 0.)
    return curvatures


def recorded_speed_plan(pose, points, target, trial, acceleration, braking, stop_delay=0.):
    """Plan bend speeds with separate acceleration and braking yaw budgets.

    ``stop_delay`` 是末段停车的指令时延；末端收敛与 limit() 使用同一制动度量，
    因此规划末速与执行限速不再各自维护一个死区。
    """
    if not trial:
        return target, None, None
    target = min(target,trial['maxSpeed'])
    lengths = [math.hypot(b['x']-a['x'],b['y']-a['y']) for a,b in zip(points,points[1:])]
    curvatures = path_curvatures(points,lengths)
    # Reserve yaw-rate headroom for heading and cross-track correction.
    caps = [min(target,.75*trial['maxYawRate']/max(abs(k),1e-9)) for k in curvatures]
    accelerations, brakes = [], []
    for i in range(len(lengths)):
        nearby = curvatures[max(0,i-1):min(len(lengths),i+2)]
        yaw_limited_rate = .5*trial['yawAcceleration']/max(max(abs(k) for k in nearby),1e-9)
        accelerations.append(min(acceleration,trial['acceleration'],yaw_limited_rate))
        brakes.append(min(braking,trial['braking'],yaw_limited_rate))
    # Split the yaw-acceleration budget between speed change and curvature change.
    for i in range(len(lengths)-1):
        gradient = abs(curvatures[i+1]-curvatures[i])/max(.001,.5*(lengths[i]+lengths[i+1]))
        if gradient>1e-9:
            cap = math.sqrt(.5*trial['yawAcceleration']/gradient)
            caps[i] = min(caps[i],cap)
            caps[i+1] = min(caps[i+1],cap)
    candidates = []
    for i,(a,b) in enumerate(zip(points,points[1:])):
        length = lengths[i]
        ux,uy = (b['x']-a['x'])/length,(b['y']-a['y'])/length
        distance = max(0.,min(length,(pose.x-a['x'])*ux+(pose.y-a['y'])*uy))
        x,y = a['x']+distance*ux,a['y']+distance*uy
        candidates.append((math.hypot(pose.x-x,pose.y-y),i,distance))
    _,index,distance = min(candidates)
    allowed = caps[index]
    # Integrate the same local braking limits that limit() will apply on the path.
    budget = 2*brakes[index]*(lengths[index]-distance)
    for i in range(index+1,len(lengths)):
        allowed = min(allowed,math.sqrt(caps[i]**2+budget))
        budget += 2*brakes[i]*lengths[i]
    # Also reach zero before the endpoint using the same piecewise brake rates.
    stop_distance = max(0., sum(lengths[index:]) - distance)
    stop_budget = 0.
    for i in range(index, len(lengths)):
        span = min(stop_distance, lengths[i] - distance if i == index else lengths[i])
        stop_budget += 2 * brakes[i] * span
        stop_distance = max(0., stop_distance - span)
    allowed = min(allowed, math.sqrt(stop_budget))
    # 末端收敛与 limit() 共用同一制动度量（含指令时延），不再各自维护死区。
    allowed = min(allowed, endpoint_brake_speed(sum(lengths[index:]) - distance,
                                                brakes[index], stop_delay))
    return allowed, accelerations[index], brakes[index]



class Tracker:
    def __init__(self, acceleration=.1, braking=.2):
        self.acceleration, self.braking = acceleration, braking
        self.previous_speed = 0.
        self.previous_forward_yaw_rate = 0.

    def reset(self):
        self.previous_speed = 0.
        self.previous_forward_yaw_rate = 0.

    def limit(self, target, remaining, dt, acceleration=None, braking=None, stop_delay=0.):
        effective_braking = self.braking if braking is None else min(self.braking, braking)
        # 与 recorded_speed_plan 完全一致的末端收敛：把指令时延折进同一制动度量。
        target = min(target, endpoint_brake_speed(remaining, effective_braking, stop_delay))
        previous = abs(self.previous_speed)
        rate = (self.acceleration if acceleration is None else min(self.acceleration, acceleration)) if target > previous else effective_braking
        value = max(0., min(previous + rate * dt, max(previous - rate * dt, target)))
        self.previous_speed = value
        return value

    def forward(self, pose, points, target, dt, profile=None, cross_override=None, stop_delay=0.):
        cross, tangent, remaining, end_distance, curvature = geometry(pose, points, include_curvature=True)
        # 横向反馈只允许一个来源：QR 失联时由调用方给入 DR 预测 cross，避免 fused/DR 两套叠加。
        cross_steer = cross if cross_override is None else cross_override
        heading_error = wrap(pose.yaw - tangent)
        trial = limits_for(profile)
        target, acceleration, braking = recorded_speed_plan(pose, points, target, trial, self.acceleration, self.braking, stop_delay)
        v = self.limit(target, remaining, dt, acceleration, braking, stop_delay)
        # 前进：航向与车体侧偏都用负反馈。
        yaw_rate = v*curvature - 1.8*heading_error - 1.5*cross_steer
        # Bound the actual body turn command before applying a slew limit.
        # A QR position correction must not become an instantaneous steering step.
        bound = min(trial['maxYawRate'],abs(v)*trial['maxCurvature']) if trial else min(.25,abs(v)*.6)
        desired = max(-bound, min(bound, yaw_rate))
        step = (trial['yawAcceleration'] if trial else .15)*max(0., min(.1, dt))
        previous = self.previous_forward_yaw_rate
        yaw_rate = max(previous-step, min(previous+step, desired))
        yaw_rate = max(-bound, min(bound, yaw_rate))
        self.previous_forward_yaw_rate = yaw_rate
        return Command(vx=v,yaw_rate=yaw_rate), cross, heading_error, remaining, end_distance

    def reverse(self, pose, reverse_points, target, dt, profile=None, stop_delay=0.):
        cross, travel_tangent, remaining, end_distance, curvature = geometry(pose, reverse_points, include_curvature=True)
        body_target = wrap(travel_tangent + math.pi)
        heading_error = wrap(pose.yaw - body_target)
        trial = limits_for(profile)
        target, acceleration, braking = recorded_speed_plan(pose, reverse_points, target, trial, self.acceleration, self.braking, stop_delay)
        speed = self.limit(target, remaining, dt, acceleration, braking, stop_delay)
        # Both cross and curvature follow the reversed travel direction. Body
        # yaw stays aligned with the original forward route, without a U-turn.
        desired = speed*curvature - 1.8*heading_error - 1.5*cross
        bound = min(trial['maxYawRate'],speed*trial['maxCurvature']) if trial else min(.25,speed*.6)
        desired = max(-bound,min(bound,desired))
        step = (trial['yawAcceleration'] if trial else .15)*max(0.,min(.1,dt))
        yaw_rate = max(self.previous_forward_yaw_rate-step,min(self.previous_forward_yaw_rate+step,desired))
        yaw_rate = max(-bound,min(bound,yaw_rate))
        self.previous_forward_yaw_rate = yaw_rate
        return Command(vx=-speed,yaw_rate=yaw_rate),cross,heading_error,remaining,end_distance

    def lateral(self, pose, start, end, body_yaw, target, dt, stop_delay=0.):
        _, tangent, remaining, end_distance = geometry(pose,[start,end])
        heading_error = wrap(pose.yaw-body_yaw)
        along = (end['x']-start['x'])*(-math.sin(body_yaw))+(end['y']-start['y'])*math.cos(body_yaw)
        cross=(pose.x-start['x'])*math.cos(body_yaw)+(pose.y-start['y'])*math.sin(body_yaw)
        speed=self.limit(target,remaining,dt,stop_delay=stop_delay)
        # 横移保持车体朝向，四轮同角；路径只能沿车体横向，不能用阿克曼纠偏。
        return Command(mode='crab',vy=math.copysign(speed,along),wheel_angle=math.copysign(90.,along)), cross, heading_error, remaining, end_distance
