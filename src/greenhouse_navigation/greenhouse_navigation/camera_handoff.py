"""仅匹配已核实的旧独立摄像头预览，不匹配其雷达/底盘/任务进程。"""
from pathlib import Path


def legacy_preview_matches(command,device,topic):
    expected='/home/orangepi/ugv/autorunlida/uvc_preview_publisher.py'
    if (len(command)<2 or Path(command[0]).name!='python3' or command[1]!=expected
            or topic!='/autorun_final/uvc_preview/compressed'
            or command.count('--source')!=1 or command.count('--image-topic')!=1):
        return False
    try:
        return (command[command.index('--image-topic')+1]==topic
                and Path(command[command.index('--source')+1]).resolve()==Path(device).resolve())
    except (IndexError,OSError,ValueError):
        return False
