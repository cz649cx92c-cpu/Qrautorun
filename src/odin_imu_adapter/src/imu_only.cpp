// 只封装设备已有SDK；不实现底盘通信，不调用图像/点云/SLAM处理。
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/imu.hpp>
#include <std_msgs/msg/string.hpp>
#include "lidar_api.h"
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <filesystem>
#include <unistd.h>

class ImuOnly : public rclcpp::Node {
 public:
  ImuOnly():Node("odin_imu_only") {
    topic_=declare_parameter<std::string>("imu_topic","/odin1/imu");
    frame_=declare_parameter<std::string>("frame_id","imu_link");
    pid_file_=declare_parameter<std::string>("pid_file","");
    gyro_scale_=declare_parameter<double>("gyro_scale",1.0);
    accel_scale_=declare_parameter<double>("accel_scale",1.0);
    if(!std::isfinite(gyro_scale_)||gyro_scale_<=0||!std::isfinite(accel_scale_)||accel_scale_<=0)throw std::runtime_error("IMU单位倍率必须为正有限值");
    imu_pub_=create_publisher<sensor_msgs::msg::Imu>(topic_,rclcpp::SensorDataQoS());
    status_pub_=create_publisher<std_msgs::msg::String>("/qr/imu/status",10);
    event_timer_=create_wall_timer(std::chrono::milliseconds(20),[this]{events();});
    status_timer_=create_wall_timer(std::chrono::seconds(1),[this]{status();});
    if(!pid_file_.empty()){std::ofstream(pid_file_)<<getpid();}
  }
  void start(){owner_=this;const int result=lidar_system_init(device_callback);if(result)throw std::runtime_error("Odin SDK初始化失败 "+std::to_string(result));initialized_=true;RCLCPP_INFO(get_logger(),"Odin仅IMU：RAW模式；没有图像、点云、SLAM、里程计或底盘命令发布者");}
  void close(){
    if(shutting_.exchange(true))return;
    if(handle_)lidar_stop_stream(handle_,LIDAR_MODE_RAW);
    // 现有SDK异步线程持有设备句柄，按原驱动的顺序由system_deinit统一清理。
    if(initialized_)lidar_system_deinit();handle_=nullptr;owner_=nullptr;
    if(!pid_file_.empty()){std::ifstream f(pid_file_);int pid=0;f>>pid;if(pid==getpid())std::filesystem::remove(pid_file_);}
  }
  ~ImuOnly(){close();}
 private:
  static inline std::atomic<ImuOnly*> owner_{nullptr};
  device_handle handle_=nullptr;bool initialized_=false;std::atomic<bool> shutting_{false};
  std::mutex mutex_;std::deque<std::pair<lidar_device_info_t,bool>> pending_;
  std::atomic<uint64_t> received_{0},other_{0},device_stamp_{0};std::atomic<int64_t> last_at_{0};
  std::array<std::atomic<uint64_t>,11> packet_counts_{};
  std::array<uint64_t,11> previous_packets_{};
  uint64_t previous_count_=0;std::string error_,serial_,topic_,frame_,pid_file_;double gyro_scale_,accel_scale_;
  rclcpp::Publisher<sensor_msgs::msg::Imu>::SharedPtr imu_pub_;
  rclcpp::Publisher<std_msgs::msg::String>::SharedPtr status_pub_;
  rclcpp::TimerBase::SharedPtr event_timer_,status_timer_;
  static void device_callback(const lidar_device_info_t *info,bool attach){auto self=owner_.load();if(!self||!info||self->shutting_)return;std::lock_guard<std::mutex> lock(self->mutex_);if(self->pending_.size()>=8)self->pending_.pop_front();self->pending_.emplace_back(*info,attach);}
  static void data_callback(const lidar_data_t *data,void *context){
    auto self=static_cast<ImuOnly*>(context);if(!self||!data||self->shutting_)return;
    if(data->type<self->packet_counts_.size())self->packet_counts_[data->type]++;
    if(data->type!=LIDAR_DT_RAW_IMU){self->other_++;return;}
    if(!data->stream.imageCount||!data->stream.imageList[0].pAddr)return;
    // 回调指针只在SDK回调内有效，立即复制；轴顺序沿用现有Odin ROS驱动。
    const auto imu=*static_cast<const imu_convert_data_t*>(data->stream.imageList[0].pAddr);
    const std::array<float,6> values={imu.accel_x,imu.accel_y,imu.accel_z,imu.gyro_x,imu.gyro_y,imu.gyro_z};
    for(auto value:values)if(!std::isfinite(value))return;
    sensor_msgs::msg::Imu msg;msg.header.stamp=self->now();msg.header.frame_id=self->frame_;
    msg.linear_acceleration.x=imu.accel_y*self->accel_scale_;msg.linear_acceleration.y=-imu.accel_x*self->accel_scale_;msg.linear_acceleration.z=imu.accel_z*self->accel_scale_;
    msg.angular_velocity.x=imu.gyro_y*self->gyro_scale_;msg.angular_velocity.y=-imu.gyro_x*self->gyro_scale_;msg.angular_velocity.z=imu.gyro_z*self->gyro_scale_;
    msg.orientation.w=1.0;msg.orientation_covariance[0]=-1.0; // 没有姿态解算，不将固定四元数当实测航向。
    // 全零角速度/加速度协方差表示未知；现场标定前不虚构融合精度。
    self->imu_pub_->publish(msg);self->received_++;self->device_stamp_=imu.stamp;self->last_at_=self->now().nanoseconds();
  }
  bool check(int result,const char *step){if(!result)return true;error_=std::string(step)+"失败，SDK返回 "+std::to_string(result);RCLCPP_ERROR(get_logger(),"%s",error_.c_str());return false;}
  void release(){if(handle_){lidar_unregister_stream_callback(handle_);lidar_close_device(handle_);handle_=nullptr;}}
  void connect(lidar_device_info_t info){
    error_.clear();serial_=std::string(reinterpret_cast<char*>(info.serial),strnlen(reinterpret_cast<char*>(info.serial),LIDAR_SERIAL_MAX));
    if(info.initial_state==LIDAR_DEVICE_STREAMING){error_="Odin已被其他程序开启，请先停止该设备的现有采集";RCLCPP_ERROR(get_logger(),"%s",error_.c_str());return;}
    if(!check(lidar_create_device(&info,&handle_),"创建设备"))return;
    lidar_data_callback_info_t cb{data_callback,this};
    if(!check(lidar_register_stream_callback(handle_,cb),"注册IMU回调")){release();return;}
    if(info.initial_state==LIDAR_DEVICE_NOT_INITIALIZED||info.initial_state==LIDAR_DEVICE_NONE){if(!check(lidar_open_device(handle_),"连接设备")){release();return;}}
    if(!check(lidar_set_mode(handle_,LIDAR_MODE_RAW),"设置RAW模式")){release();return;}
    // RAW模式下明确关闭所有非IMU流；SLAM算法未启动，不请求SLAM流。
    // 这版SDK仅支持原驱动所用的四个开关；RAW模式下SLAM扩展流不会启动。
    for(int type:{LIDAR_DT_RAW_RGB,LIDAR_DT_RAW_DTOF,LIDAR_DT_SLAM_CLOUD,LIDAR_DT_SLAM_ODOMETRY}){
      if(!check(lidar_deactivate_stream_type(handle_,type),"关闭非IMU数据流")){release();return;}
    }
    if(!check(lidar_activate_stream_type(handle_,LIDAR_DT_RAW_IMU),"启用IMU")){release();return;}
    uint32_t unused=0;
    // 按现有可用驱动调用约定，start_stream的第二参数是运行模式RAW。
    if(!check(lidar_start_stream(handle_,LIDAR_MODE_RAW,unused),"开始IMU采集")){release();return;}
    // SDK start_stream会重新设置流开关，启动后再次应用仅IMU配置。
    for(int type:{LIDAR_DT_RAW_RGB,LIDAR_DT_RAW_DTOF,LIDAR_DT_SLAM_CLOUD,LIDAR_DT_SLAM_ODOMETRY}){
      if(!check(lidar_deactivate_stream_type(handle_,type),"关闭非IMU数据流")){lidar_stop_stream(handle_,LIDAR_MODE_RAW);release();return;}
    }
    if(!check(lidar_activate_stream_type(handle_,LIDAR_DT_RAW_IMU),"确认IMU启用")){lidar_stop_stream(handle_,LIDAR_MODE_RAW);release();return;}
    RCLCPP_INFO(get_logger(),"IMU设备连接：%s，发布 %s；时间戳为主机接收时间",serial_.c_str(),topic_.c_str());
  }
  void events(){std::deque<std::pair<lidar_device_info_t,bool>> events;{std::lock_guard<std::mutex> lock(mutex_);events.swap(pending_);}for(auto &event:events){if(event.second){if(!handle_)connect(event.first);}else{last_at_=0;error_="Odin已断开";handle_=nullptr;}}}
  void status(){const auto total=received_.load(),rate=total-previous_count_;previous_count_=total;const auto last=last_at_.load();const bool online=last&&now().nanoseconds()-last<500000000LL;std_msgs::msg::String msg;std::ostringstream s;
    s<<"{\"mode\":\"imu_only\",\"online\":"<<(online?"true":"false")<<",\"rateHz\":"<<rate<<",\"received\":"<<total<<",\"nonImuPackets\":"<<other_.load()<<",\"deviceStamp\":"<<device_stamp_.load()<<",\"timestampSource\":\"host_receive\",\"orientationAvailable\":false,\"packetRates\":{";
    for(size_t i=0;i<packet_counts_.size();i++){const auto count=packet_counts_[i].load();if(i)s<<",";s<<"\""<<i<<"\":"<<count-previous_packets_[i];previous_packets_[i]=count;}s<<"}}";msg.data=s.str();status_pub_->publish(msg);
    if(!online)RCLCPP_WARN_THROTTLE(get_logger(),*get_clock(),10000,"IMU未出数：%s",error_.empty()?"等待设备或采集数据":error_.c_str());
  }
};
int main(int argc,char **argv){rclcpp::init(argc,argv);std::shared_ptr<ImuOnly> node;int result=0;try{node=std::make_shared<ImuOnly>();node->start();rclcpp::spin(node);}catch(const std::exception &e){RCLCPP_ERROR(rclcpp::get_logger("odin_imu_only"),"%s",e.what());result=1;}if(node)node->close();rclcpp::shutdown();
 // 已显式停止采集、完成SDK deinit并删除PID。此版本SDK的进程静态析构再次
 // 关闭已清理的sender并触发terminate，避免重复析构SDK静态对象。
 std::fflush(nullptr);std::_Exit(result);
}
