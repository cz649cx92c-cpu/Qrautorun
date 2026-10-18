from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([DeclareLaunchArgument('params',default_value='/home/orangepi/ugv/QRautorun/qr_navigation_ws/config/navigation.yaml'),Node(package='greenhouse_navigation',executable='navigation',name='greenhouse_navigation',parameters=[LaunchConfiguration('params')],output='screen')])
