"""多码板几何：输入为 base_link 米/弧度，输出逻辑标记为整组中心。

子码只承载独立 AprilTag ID；偏移、物理尺寸和所属板必须来自保存的布局。
"""
import math


def wrap(angle):
    return math.atan2(math.sin(angle), math.cos(angle))


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_boards(boards):
    if not isinstance(boards, list):
        raise ValueError('多码布局必须是列表')
    ids, names = set(), set()
    for board in boards:
        if not isinstance(board,dict):raise ValueError('多码布局必须包含对象')
        n = board.get('gridSize')
        size_mm, gap_mm = board.get('sizeMm'), board.get('gapMm')
        if type(n) is not int or not 1 <= n <= 6 or not _finite(size_mm) or not 20 <= size_mm <= 180:
            raise ValueError('多码组规格或整组尺寸错误')
        if not _finite(gap_mm) or gap_mm != 2 or size_mm <= (n - 1) * gap_mm:
            raise ValueError('多码组间隔错误')
        reference_id=board.get('referenceId')
        if type(reference_id) is not int or not 0<=reference_id<=586:
            raise ValueError('多码组首个 ID 无效')
        if not isinstance(board.get('id'), str) or board['id']!=f'B{reference_id:03d}' or board['id'] in names:
            raise ValueError('多码组编号重复或缺失')
        names.add(board['id'])
        members = board.get('members')
        if not isinstance(members, list) or len(members) != n * n:
            raise ValueError('多码组成员数量错误')
        tile = (size_mm - (n - 1) * gap_mm) / n / 1000
        for index, member in enumerate(members):
            if not isinstance(member,dict):raise ValueError('子码几何必须为对象')
            marker_id = member.get('id')
            if type(marker_id) is not int or not 0 <= marker_id <= 586 or marker_id in ids or marker_id!=reference_id+index:
                raise ValueError('子码 ID 必须全局唯一且在 tag36h11 范围内')
            ids.add(marker_id)
            if not all(_finite(member.get(k)) for k in ('x', 'y', 'angle', 'size')) or not .01<=member['size']<=.15 or member['angle']!=0:
                raise ValueError('子码几何必须有限且尺寸为正')
            col, row = index % n, index // n
            expected_x = (col - (n - 1) / 2) * (tile + gap_mm / 1000)
            expected_y = ((n - 1) / 2 - row) * (tile + gap_mm / 1000)
            if abs(member['size'] - tile / 1.25) > 1e-7 or abs(member['x'] - expected_x) > 1e-7 or abs(member['y'] - expected_y) > 1e-7:
                raise ValueError('子码尺寸/位置与整组打印规格不一致')
        if type(board.get('referenceId')) is not int or board['referenceId'] != members[0]['id']:
            raise ValueError('逻辑 ID 必须为已注册首个子码 ID')
    return boards


def _valid_observation(observation):
    return isinstance(observation, dict) and type(observation.get('id')) is int and 0<=observation['id']<=586 and all(
        _finite(observation.get(k)) for k in ('x', 'y', 'angle', 'sigma')
    ) and observation['sigma'] > 0 and ('angleSigma' not in observation or (_finite(observation['angleSigma']) and observation['angleSigma']>0))


def member_to_board(observation, member):
    """T_base_board = T_base_member * inverse(T_board_member)."""
    angle = wrap(observation['angle'] - member['angle'])
    c, s = math.cos(angle), math.sin(angle)
    return {'x': observation['x'] - c * member['x'] + s * member['y'],
            'y': observation['y'] - s * member['x'] - c * member['y'],
            'angle': angle, 'sigma': observation['sigma'], 'memberId': member['id']}


def collapse_group_observations(tags, boards, position_tolerance=.04, angle_tolerance=.15):
    """同帧同组做严格多数一致融合；两个冲突子码不选择其一。

    同组子码的标定/曝光误差相关，因此 sigma 不按 sqrt(观测数) 虚假缩小。
    未注册的单码保持旧接口；无观测或无一致多数不会输出该组。
    """
    validate_boards(boards)
    if not isinstance(tags, list):
        raise ValueError('观测必须是列表')
    lookup = {m['id']: (b, m) for b in boards for m in b['members']}
    grouped, singles, seen = {}, [], set()
    for tag in tags:
        if not _valid_observation(tag) or tag['id'] in seen:
            continue
        seen.add(tag['id'])
        if tag['id'] not in lookup:
            singles.append(dict(tag))
            continue
        board, member = lookup[tag['id']]
        grouped.setdefault(board['id'], (board, []))[1].append(member_to_board(tag, member))
    result = singles
    for board, candidates in grouped.values():
        # 保证组内两两一致，拒绝链式近邻将互相矛盾的子码混为一组。
        compatible = lambda a, b: math.hypot(a['x']-b['x'], a['y']-b['y']) <= position_tolerance and abs(wrap(a['angle']-b['angle'])) <= angle_tolerance
        clusters = []
        for seed in candidates:
            cluster = [seed]
            for other in sorted(candidates, key=lambda c: math.hypot(c['x']-seed['x'], c['y']-seed['y'])):
                if other is not seed and all(compatible(other, item) for item in cluster):
                    cluster.append(other)
            clusters.append(cluster)
        cluster = max(clusters, key=len)
        if len(candidates) > 1 and len(cluster) <= len(candidates) / 2:
            continue
        # 最大一致子集不唯一时，不能凭观测顺序选择一个中心。
        memberships={tuple(sorted(item['memberId'] for item in c)) for c in clusters if len(c)==len(cluster)}
        if len(memberships)>1:continue
        weights = [1 / max(item['sigma'], .005)**2 for item in cluster]
        total = sum(weights)
        x = sum(item['x']*w for item,w in zip(cluster,weights))/total
        y = sum(item['y']*w for item,w in zip(cluster,weights))/total
        angle = math.atan2(sum(math.sin(item['angle'])*w for item,w in zip(cluster,weights)), sum(math.cos(item['angle'])*w for item,w in zip(cluster,weights)))
        penalty = math.sqrt(len(board['members']) / len(cluster))
        if len(cluster) == 1:
            penalty = max(1.5, penalty)
        spread = max(math.hypot(item['x']-x, item['y']-y) for item in cluster)
        sigma = math.hypot(max(max(item['sigma'] for item in cluster), .01)*penalty, spread)
        result.append({'id': board['referenceId'], 'groupId': board['id'],
                       'memberIds': sorted(item['memberId'] for item in cluster),
                       'visibleCount': len(cluster), 'detectedCount': len(candidates),
                       'rejectedMemberIds': sorted(item['memberId'] for item in candidates if item not in cluster),
                       'x': x, 'y': y, 'angle': angle, 'sigma': sigma,
                       'angleSigma': max(.02*penalty, max(abs(wrap(item['angle']-angle)) for item in cluster)),
                       'size': board['sizeMm']/1000})
    return result


def same_board_layout(a,b):
    """比较打印几何，无视额外存储元数据；严格禁止错误布局共用逻辑 ID。"""
    if any(a.get(k)!=b.get(k) for k in ('id','referenceId','gridSize')):return False
    if any(abs(a[k]-b[k])>1e-9 for k in ('sizeMm','gapMm')):return False
    return len(a['members'])==len(b['members']) and all(
        x['id']==y['id'] and all(abs(x[k]-y[k])<=1e-9 for k in ('x','y','angle','size'))
        for x,y in zip(a['members'],b['members']))


def validated_board_observations(tags, boards, group_layouts=None):
    """已转换整组中心不可再次减偏移，且必须匹配地图中保存的成员关系。"""
    validate_boards(boards)
    if group_layouts is not None:validate_boards(group_layouts)
    by_name = {b['id']: b for b in boards}
    snapshot=None if group_layouts is None else {b['id']:b for b in group_layouts}
    child_ids = {m['id'] for b in boards for m in b['members']}
    result, seen = [], set()
    for tag in tags:
        if not _valid_observation(tag) or tag['id'] in seen:
            continue
        name = tag.get('groupId')
        if name is None:
            if tag['id'] not in child_ids:
                result.append(tag);seen.add(tag['id'])
            continue
        board = by_name.get(name)
        members = tag.get('memberIds')
        if board is None or tag['id'] != board['referenceId'] or not isinstance(members,list) or not members:
            continue
        if snapshot is not None and (name not in snapshot or not same_board_layout(board,snapshot[name])):continue
        if any(type(mid) is not int for mid in members) or len(set(members)) != len(members) or not set(members).issubset({m['id'] for m in board['members']}) or tag.get('visibleCount') != len(members):
            continue
        penalty=math.sqrt(len(board['members'])/len(members))
        if len(members)==1:penalty=max(1.5,penalty)
        angle_sigma=tag.get('angleSigma',.02*penalty)
        if not _finite(angle_sigma) or angle_sigma<=0:continue
        checked=dict(tag);checked['sigma']=max(tag['sigma'],.01*penalty);checked['angleSigma']=max(float(angle_sigma),.02*penalty)
        result.append(checked);seen.add(tag['id'])
    return result
