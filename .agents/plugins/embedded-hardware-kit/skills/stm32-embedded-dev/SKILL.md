---
name: stm32-embedded-dev
description: >-
  Use this skill when developing, reviewing, or debugging embedded firmware for STM32
  (especially STM32G4/FOC motor control), STM8/SDCC, CubeMX .ioc configurations, TIM1/TIM8
  complementary PWM, ADC injected/DMA synchronization, SPI encoders/gate drivers, FDCAN,
  USB-CDC, and embedded C/C++ safety/ISR static reviews.
---

# STM32 / STM8 嵌入式固件开发与调机工作流

## 1. CubeMX (`.ioc`) 与引脚/时钟树核对

在编写或修改任何外设驱动前，先读取工程的 `.ioc` 文件与 `Core/Inc/main.h`、`stm32*_hal_msp.c`：
1. **时钟树校验**：核对 HSE 晶振频率、PLL 倍频分频、SYSCLK（如 STM32G474 主频 170MHz）、ADC 时钟分频与超频上限、USB 48MHz 时钟源（HSI48 或 PLLQ）、FDCAN 时钟源。
2. **电机控制定时器与 ADC 同步**：
   - `TIM1` / `TIM8` 须配为中心对齐模式（Center-Aligned）、互补输出 `CHx`/`CHxN`、硬件死区（DTG）与 `BKIN` 刹车输入（关联预驱 `nFAULT`）。
   - 核对 `TRGO`（如 `OC4REF` 或 `UPDATE`）触发 ADC 注入组采样点是否落在 PWM 中点安全窗口内。
3. **DMA 与中断优先级**：
   - 高频电流环中断（20kHz~40kHz）须设最高抢占优先级（如 NVIC 0），不得在电流环 ISR 中执行阻塞延时（`HAL_Delay`）、`printf` 或耗时浮点串口发送。
   - 通信中断（SPI 编码器 DMA、FDCAN RX、USB CDC、UART）优先级低于电流环。

---

## 2. 电机驱动 / FOC 分阶段安全上电调试流程（Bring-up）

严格按阶段推进，**上一阶段未通过禁止直接进入闭环或提高母线电压**：

- **Stage 0 — 电源轨与下载口空载体检**
  - 限流电源（或串限流电阻）上电，先测 `24V`、`5V`、`3.3V`、`VDDA`、`1.65V` 偏置电压无短路/过压，SWD 正常识别芯片并烧录闪烁 LED。
- **Stage 1 — 预驱 SPI 通信与 `nFAULT` 状态检查**
  - 读取 `DRV8320S` 状态寄存器，确认通信正常、无 `VCP` 欠压或门极故障；验证硬件使能引脚与 `nFAULT` 中断/刹车响应。
- **Stage 2 — 编码器 SPI 原始角度与方向校验**
  - 高速读取磁编码器（如 `MT6701`），手转电机一圈确认角度单调连续（`0 ~ 2π`）、无跳变/CRC 校验错、极对数与正反转方向定义一致。
- **Stage 3 — 0A 静态电流采样偏置校准**
  - PWM 全关断状态下连续采样 U/V 相 ADC 多帧求均值（应在 `1.65V` 附近，12-bit 约 `2048`），记录通道零点偏置，核对采样正方向与三相电流符号约定。
- **Stage 4 — 低压开环 `Vd / Vq` 拖转测试**
  - 设置极低电压限幅与电源限流，发固定电角度斜坡开环旋转，用示波器或 USB-CDC 波形确认三相电流正弦度、相序与编码器电角度零偏对齐。
- **Stage 5 — 闭环电流环（Id/Iq）与速度/位置环**
  - 先整定 `Id=0`、`Iq` 小阶跃响应，观察实际电流跟踪与保护阈值触发，确认无振荡或飞车风险后再切入速度/位置外环。

---

## 3. 嵌入式 C / C++ 静态审查清单

审查或编写固件代码时重点排查以下隐患：
- **并发与可见性**：ISR 与主循环共享变量是否使用 `volatile`、关中断临界区或原子标志，避免多字节结构体读写撕裂（Tearing）。
- **DMA 缓冲区**：DMA 收发缓冲区是否声明在全局/静态区（禁止使用栈上局部变量），生命周期与长度是否匹配，双缓冲/半传输回调是否防重入。
- **数值与边界安全**：
  - 电流/电压采样换算防除零、ADC 饱和裁剪、PID 积分抗饱和（Anti-windup）与输出限幅；
  - 角度回绕处理（`wrap_2pi` / `wrap_pi`），定点数或单精度浮点（`float` 加 `f` 后缀避免 STM32F4/G4 退化为软件 `double` 运算）。
- **故障恢复与看门狗**：过流/过压/过温/编码器断线/CAN 离线（Bus-Off / 心跳超时）后是否立即封锁 PWM 并保持安全态，禁止未清故障直接自动重启输出。
- **STM8 / SDCC 专项**（如涉及 STM8 项目）：检查栈空间大小、中断向量号与修饰符（`__interrupt(n)`）、`small`/`large` 内存模式、避免重入函数未加 `--stack-auto` 或手动保护。
