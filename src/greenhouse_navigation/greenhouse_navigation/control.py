"""独立前进、倒车与四轮横移路径跟踪。输出车体速度/角速度，不实现电机通信。"""
from dataclasses import dataclass
import math
from .recorded_trial import limits_for


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


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


def recorded_speed_plan(pose, points, target, trial, acceleration, braking):
    """Plan bend speeds with separate acceleration and braking yaw budgets."""
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
    stop_distance = max(0.,sum(lengths[index:])-distance-.025)
    stop_budget = 0.
    for i in range(index,len(lengths)):
        span = min(stop_distance,lengths[i]-distance if i==index else lengths[i])
        stop_budget += 2*brakes[i]*span
        stop_distance = max(0.,stop_distance-span)
    allowed = min(allowed,math.sqrt(stop_budget))
    return allowed,accelerations[index],brakes[index]



class Tracker:
    def __init__(self, acceleration=.1, braking=.2):
        self.acceleration, self.braking = acceleration, braking
        self.previous_speed = 0.
        self.previous_forward_yaw_rate = 0.

    def reset(self):
        self.previous_speed = 0.
        self.previous_forward_yaw_rate = 0.

    def limit(self, target, remaining, dt, acceleration=None, braking=None):
        effective_braking=self.braking if braking is None else min(self.braking,braking)
        target = min(target, math.sqrt(max(0., 2*effective_braking*max(0.,remaining-.025))))
        previous = abs(self.previous_speed)
        rate = (self.acceleration if acceleration is None else min(self.acceleration,acceleration)) if target > previous else effective_braking
        value = max(0., min(previous+rate*dt, max(previous-rate*dt,target)))
        self.previous_speed = value
        return value

    def forward(self, pose, points, target, dt, profile=None, cross_override=None):
        cross, tangent, remaining, end_distance, curvature = geometry(pose, points, include_curvature=True)
        # 横向反馈只允许一个来源：QR 失联时由调用方给入 DR 预测 cross，避免 fused/DR 两套叠加。
        cross_steer = cross if cross_override is None else cross_override
        heading_error = wrap(pose.yaw-tangent)
        trial=limits_for(profile)
        target,acceleration,braking=recorded_speed_plan(pose,points,target,trial,self.acceleration,self.braking)
        v = self.limit(target,remaining,dt,acceleration,braking)
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

    def reverse(self, pose, reverse_points, target, dt, profile=None):
        cross, travel_tangent, remaining, end_distance, curvature = geometry(pose,reverse_points,include_curvature=True)
        body_target = wrap(travel_tangent+math.pi)
        heading_error = wrap(pose.yaw-body_target)
        trial=limits_for(profile)
        target,acceleration,braking=recorded_speed_plan(pose,reverse_points,target,trial,self.acceleration,self.braking)
        speed = self.limit(target,remaining,dt,acceleration,braking)
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

    def lateral(self, pose, start, end, body_yaw, target, dt):
        _, tangent, remaining, end_distance = geometry(pose,[start,end])
        heading_error = wrap(pose.yaw-body_yaw)
        along = (end['x']-start['x'])*(-math.sin(body_yaw))+(end['y']-start['y'])*math.cos(body_yaw)
        cross=(pose.x-start['x'])*math.cos(body_yaw)+(pose.y-start['y'])*math.sin(body_yaw)
        speed=self.limit(target,remaining,dt)
        # 横移保持车体朝向，四轮同角；路径只能沿车体横向，不能用阿克曼纠偏。
        return Command(mode='crab',vy=math.copysign(speed,along),wheel_angle=math.copysign(90.,along)), cross, heading_error, remaining, end_distance
