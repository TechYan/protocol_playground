# PCIe 链路分析仪的协议核对

核对日期为 2026-11-18。演示选择单 Lane、直接连接的典型训练路径。PIPE 使用 SerDes 架构、PHY 输出 PCLK，并选择实现可选的接收控制字段。Tracker Log 每行记录一个方向在该区间的代表性发送。事件边界和下列规则可以独立复核。[打开分析仪](https://techyan.github.io/protocol_playground/pcie/ltssm/)

| 观察点 | 本页的处理 | 依据 |
| --- | --- | --- |
| 训练与模式协商 | 以 2.5 GT/s 开始，经过 Polling 与 Configuration。本例双方在 Linkwidth.Accept 确认 Flit 支持。逐档升速是一条选定路径。 | Base 6.0 §§4.2.5、4.2.7.1–4 |
| RcvrCfg → Speed → RcvrLock | 32 GT/s 的 EQ TS2 传递预置。进入 Speed 先发 EIOSQ，再电气空闲。切至 64 GT/s 后重新锁定并进入 EQ。 | Base §§4.2.4、4.2.5.3、4.2.7.4 |
| 换速握手 | P0 中先置 TxElecIdle 和 RxStandby，随后改变 Rate。Rate 0101 表示请求 64 GT/s。等待 PhyStatus 响应后更新活动速率，随后释放待机。 | PIPE 7.1 表 6-5、§8.4.1 |
| 复位与检测 | Reset# 释放后以 PhyStatus 下降表示就绪。在 P1 保持检测请求，到完成周期读取 RxStatus=011，然后撤销请求。SerDes 的其他接收状态码留空。 | PIPE §§6.1.3、8.2、8.7 |
| 端口角色 | DS 从 P1 启动，US 先处于 P0。64 GT/s 下 TS0 只占 PAM4 外侧电平。DS 在 P2 改发 TS1，US 在 P3 改发 TS1。 | Base §§4.2.4、4.2.7.4.2，Cadence 双向 EQ 示例 |
| 接收端可选字段 | 在换速完成后、释放 RxStandby 前设置 PHY Rx Control2[2]。请求远端改发 TS1 时，US 在 P2 清除本地字段，DS 在 P3 清除本地字段。显示的是寄存器逻辑值。 | PIPE §7.1.6，地址 05h，PAM4RestrictedLevels |
| 数据流开始 | 128b/130b Flit 使用 SDS → Control SKP → IDLE Flit。1b/1b 使用两个连续 SDS，再发 Control SKP 与 IDLE Flit。逻辑空闲与电气空闲分别解码。 | Base §§4.2.5.7、4.2.7.3.6、4.2.7.4.5 |
| 低功耗 | 32 GT/s Non-Flit 的 DS 可进入 Tx_L0s，US 发送仍可活动。退出使用 EIEOSQ → FTS → EIEOSQ → SDS。L1.Entry 时发端已在电气空闲，从 L1 唤醒经 Recovery。P2 中 US 可发送 Beacon。 | Base §§4.2.7.5–8，PIPE §§6.1.3、8.3.1、8.11 |
| 诊断、复位与空档 | Hot Reset 及 Disabled 片段间显式保留观测间隔。Loopback 跟随端在 SerDes MAC 中回送数据，TxDetectRx/Loopback 引脚仅用于检测。合规测试夹具的未知返回值显示为 X。 | Base §§4.2.7.2、4.2.7.9–11，PIPE 表 6-5 |

### 波形与眼图

- 协议窗的一格代表压缩时序中的一个示例采样。换速/检测的完成脉冲绘制为一个代表性 PCLK。电气窗以实际符号率换算 UI。32 GT/s NRZ 和 64 GT/s PAM4 在本例都为 32 GBd，每 UI 为 31.25 ps。
- 每个方向使用固定种子的 384 个代表性符号和 32 samples/UI。四抽头发送滤波器、带记忆的信道、有限边沿、抖动及噪声共同产生归一化接收样本。眼图叠加其中 377 段 2 UI 窗口，示波窗可查看 Vd 或相对共模的 Vp、Vn。
- “均衡前参考”保持符号、信道、抖动与噪声相同，关闭发送补偿。眼高取符号中心相邻电平的第 5 / 95 百分位差，界面显示各眼中的最小值。模拟滤波参数独立于 PCIe 规范预置编号。
- 日志呈现发送的内容类型、方向及已知字段。电气空闲没有高速符号。Beacon 与部分固定有序集只显示内容类型，其他活动区间的电平序列用于展示调制。原始包字节、真实信道、实测眼图、BER、精确计数/超时、周期性 OS 插入、多 Lane、Retimer、事务完成和排序均未建模。

### 来源与复现

协议一手资料见 [PCI-SIG Base 规范目录](https://pcisig.com/specifications)、[PCI Express Base 6.0 v1.0 公开课程副本](https://courses.cs.washington.edu/courses/cse548/26au/readings/PCI%20Express%20Base%20Specification%20Revision%206.0.pdf)、[Intel PIPE 7.1](https://cdrdv2-public.intel.com/643108/643108_PIPE_Arch_Spec_Rev_7_1.pdf) 和 [Cadence EQ 过程说明](https://community.cadence.com/cadence_blogs_8/b/fv/posts/demonstrating-pcie-6-0-equalization-procedure)。

分析界面借鉴 Summit 的状态跟踪、WaveDrom 的分组时序，以及 PyBERT 以接收样本构成眼图的方法。网页仅使用内置 JavaScript、SVG 和 Canvas。[Summit 分析仪](https://www.teledynelecroy.com/protocolanalyzer/nvm-express/pci-express-summit-t34) · [WaveDrom 3.8.0](https://github.com/wavedrom/wavedrom/tree/5f44f7d836c550fa1f0fff2ea23cc95a5c0695e3) · [PyBERT 11.2.0](https://github.com/capn-freako/PyBERT/tree/fc4a55725539af59fcc2e0c418a9e67969d8e0cb)

运行 `node tests/pcie-ltssm.mjs` 可复核场景路径、握手、方向、日志、电平和眼图采样。打开页面后默认停在 Gen6 P2，切换 DS / US 可看到三眼与单眼。用 Home 回到同一场景的 32 GT/s NRZ 起点。RTL、目标 PHY 和硬件合规测试的状态均为 NOT_RUN。
