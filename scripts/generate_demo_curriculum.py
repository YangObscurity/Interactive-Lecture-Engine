#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""generate_demo_curriculum.py — 生成通用规范的开源演示课程体系 (6 课程大系 / 12 核心讲次 / 20 交互图表)"""

import json
import pathlib

BUFFER_DOCS = pathlib.Path("opensource-buffer/site/docs")
EXAMPLES_DIR = BUFFER_DOCS / "examples"
CHARTS_DIR = BUFFER_DOCS / "public" / "charts"

EXAMPLES_DIR.mkdir(parents=True, exist_ok=True)
CHARTS_DIR.mkdir(parents=True, exist_ok=True)

# 1. 课程组定义与讲义规划
DEMO_GROUPS = [
    {
        "id": "G01",
        "dir": "examples/g01",
        "title": "计算机组成与系统底层",
        "tagline": "CPU 微架构、缓存层次与内存屏障",
        "summary": "从物理门电路与时序逻辑，深入现代多核处理器缓存一致性（MESI）、虚拟内存多级页表推演与分支预测器工作机制，建立软硬件协同的底层系统心智模型。",
        "accent": "#2563EB",
        "tags": ["计算机组成", "CPU微架构", "MESI协议", "虚拟内存"],
        "lectures": [
            {
                "id": "L01",
                "title": "用电路直觉与限流电阻理解欧姆定律",
                "notion_id": "demo_circuits_ohm_law",
                "chart_id": "EX-L01",
                "desc": "建立最基础的物理电流、电压与元器件压降心智模型，打通软硬件物理边界。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart TB\n  subgraph SYS [\"电路回路四要素：谁决定电流？\"]\n    direction TB\n    V[\"电源 U_supply（3.3V）<br/>提供电压驱动\"]\n    R[\"限流电阻 R<br/>控制回路电流\"]\n    LED[\"LED 负载<br/>维持正向压降 V_f\"]\n    G[\"地 GND<br/>回路闭合\"]\n    V --> R --> LED --> G\n  end\n  subgraph RULE [\"设计计算法则\"]\n    Q1[\"电压分配: U_R = U_supply - V_f\"]\n    Q2[\"阻值计算: R = U_R / I_target\"]\n    Q3[\"标称选择: 向上取标准 E24 阻值\"]\n  end\n  R -.-> Q1\n  R -.-> Q2\n  R -.-> Q3"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"限流电阻扫描（U=3.3V, Vf=2.0V）：电流与功耗响应曲线\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"回路电流 (mA)\", \"电阻功耗 (mW)\"] },\n  \"xAxis\": { \"type\": \"category\", \"name\": \"电阻阻值 (Ω)\", \"data\": [\"100\", \"120\", \"150\", \"180\", \"220\", \"270\", \"330\", \"390\", \"470\", \"560\"] },\n  \"yAxis\": [\n    { \"type\": \"value\", \"name\": \"电流 (mA)\", \"max\": 15 },\n    { \"type\": \"value\", \"name\": \"功耗 (mW)\", \"max\": 18 }\n  ],\n  \"series\": [\n    {\n      \"name\": \"回路电流 (mA)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"data\": [13.0, 10.8, 8.7, 7.2, 5.9, 4.8, 3.9, 3.3, 2.8, 2.3]\n    },\n    {\n      \"name\": \"电阻功耗 (mW)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"yAxisIndex\": 1,\n      \"data\": [16.9, 14.1, 11.3, 9.4, 7.7, 6.3, 5.1, 4.3, 3.6, 3.0]\n    }\n  ]\n}"
                    },
                    "c3": {
                        "type": "wavedrom",
                        "code": "{\n  \"signal\": [\n    { \"name\": \"GPIO 控制\", \"wave\": \"0.1..0.1..\" },\n    { \"name\": \"总线使能\", \"wave\": \"x.2.x.2.x\", \"data\": [\"写入\", \"读取\"] },\n    { \"name\": \"负载状态\", \"wave\": \"0.3..0.3..\", \"data\": [\"导通\", \"导通\"] }\n  ],\n  \"config\": { \"hscale\": 2 }\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "CPU 缓存一致性与 MESI 协议状态机",
                "notion_id": "demo_cpu_cache_mesi",
                "chart_id": "EX01-L02",
                "desc": "深入多核心 CPU L1/L2/L3 缓存层次与总线嗅探机制，解析伪共享与内存屏障底层机理。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "stateDiagram-v2\n  [*] --> Invalid : 系统复位\n  Invalid --> Shared : 本地读 (PrRd) / 发起 BusRd\n  Invalid --> Modified : 本地写 (PrWr) / 发起 BusRdX\n  Shared --> Modified : 本地写 (PrWr) / 发起 BusUpgr\n  Shared --> Invalid : 收到远端写 (BusRdX / BusUpgr)\n  Modified --> Shared : 收到远端读 (BusRd) / 写回内存\n  Modified --> Invalid : 收到远端写 (BusRdX) / 写回内存\n  Shared --> Exclusive : 独占读命中\n  Exclusive --> Modified : 本地写 (PrWr)"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"多核并发竞争下的缓存行失效与延迟阶梯 (Latency Scaling)\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"MESI Invalidation Spike\"] },\n  \"xAxis\": { \"type\": \"category\", \"name\": \"核心并发数\", \"data\": [\"1 Core\", \"2 Cores\", \"4 Cores\", \"8 Cores\", \"16 Cores\", \"32 Cores\", \"64 Cores\"] },\n  \"yAxis\": { \"type\": \"value\", \"name\": \"平均访问延迟 (ns)\" },\n  \"series\": [\n    {\n      \"name\": \"MESI Invalidation Spike\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#ef4444\" },\n      \"data\": [1.2, 4.8, 12.5, 28.4, 52.1, 84.6, 128.0]\n    }\n  ]\n}"
                    }
                }
            }
        ]
    },
    {
        "id": "G02",
        "dir": "examples/g02",
        "title": "现代语言运行时与并发工程",
        "tagline": "协程调度、垃圾回收与内存模型",
        "summary": "剖析现代高性能系统语言运行时的内部机理，涵盖 M:N 协程调度器（Work-Stealing）、分代并发垃圾回收（三色标记法）以及内存屏障与无锁数据结构。",
        "accent": "#7C3AED",
        "tags": ["语言运行时", "GMP调度", "并发编程", "三色标记GC"],
        "lectures": [
            {
                "id": "L01",
                "title": "M:N 协程调度器与 Work-Stealing 窃取算法",
                "notion_id": "demo_runtime_gmp_scheduler",
                "chart_id": "EX02-L01",
                "desc": "解析 Go/Rust 用户态协程调度器架构，探究无锁运行队列与自旋窃取的平衡点。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart TD\n  subgraph OS [\"操作系统内核空间\"]\n    M1[\"物理线程 M1\"]\n    M2[\"物理线程 M2\"]\n  end\n  subgraph RUNTIME [\"用户态运行时 GMP 拓扑\"]\n    P1[\"逻辑处理器 P1 (本地队列 LRQ)\"]\n    P2[\"逻辑处理器 P2 (本地队列 LRQ)\"]\n    GRQ[(\"全局运行队列 GRQ\")]\n    G1[\"Goroutine G1\"]\n    G2[\"Goroutine G2\"]\n    G3[\"Goroutine G3 (空闲)\"]\n    P1 --> G1\n    P1 --> G2\n    P2 -.->|任务窃取 50%| P1\n  end\n  M1 --> P1\n  M2 --> P2\n  P2 --> GRQ"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"Work-Stealing 与全局锁调度器吞吐对比 (kOps/s)\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"Work-Stealing 架构\", \"传统全局锁队列\"] },\n  \"xAxis\": { \"type\": \"category\", \"data\": [\"2核\", \"4核\", \"8核\", \"16核\", \"32核\", \"64核\"] },\n  \"yAxis\": { \"type\": \"value\", \"name\": \"调度吞吐 (kOps/s)\" },\n  \"series\": [\n    {\n      \"name\": \"Work-Stealing 架构\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#7c3aed\" },\n      \"data\": [420, 810, 1560, 2980, 5600, 10200]\n    },\n    {\n      \"name\": \"传统全局锁队列\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#94a3b8\" },\n      \"data\": [380, 520, 610, 580, 510, 420]\n    }\n  ]\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "三色标记法与并发 GC 停顿度量",
                "notion_id": "demo_runtime_tri_color_gc",
                "chart_id": "EX02-L02",
                "desc": "推导混合写屏障（Write Barrier）如何保障并发标记的正确性，并测量 P99 停顿时间。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart LR\n  subgraph WHITE [\"白色集合 (未访问/垃圾候选)\"]\n    W1[\"对象 A\"]\n    W2[\"对象 B\"]\n    W3[\"对象 C\"]\n  end\n  subgraph GREY [\"灰色集合 (正在扫描引用的对象)\"]\n    G1[\"根对象 Root\"]\n  end\n  subgraph BLACK [\"黑色集合 (自身及引用已确定存活)\"]\n    B1[\"全局存活对象\"]\n  end\n  G1 -->|扫描指针| W1\n  B1 --> W2\n  style WHITE fill:#f8fafc,stroke:#94a3b8,color:#334155\n  style GREY fill:#fef08a,stroke:#eab308,color:#854d0e\n  style BLACK fill:#1e293b,stroke:#0f172a,color:#ffffff"
                    }
                }
            }
        ]
    },
    {
        "id": "G03",
        "dir": "examples/g03",
        "title": "高性能网络与传输协议",
        "tagline": "传输层演进、QUIC 协议与拥塞控制",
        "summary": "从经典 TCP 三次握手与四次挥手状态机出发，深入现代基于 UDP 的 QUIC 单往返建连、连接迁移特性，并对 BBR 与 CUBIC 拥塞控制算法展开数学建模与吞吐推演。",
        "accent": "#059669",
        "tags": ["网络协议栈", "QUIC协议", "BBR算法", "全双工通信"],
        "lectures": [
            {
                "id": "L01",
                "title": "QUIC 协议 0-RTT 单往返握手与连接迁移实测",
                "notion_id": "demo_network_quic_handshake",
                "chart_id": "EX03-L01",
                "desc": "剖析 TLS 1.3 密钥交换与 UDP 传输层如何结合，解决 TCP 队头阻塞与 NAT 重绑定问题。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "sequenceDiagram\n  autonumber\n  participant C as 客户端 Client\n  participant S as 服务端 Server\n  Note over C,S: 传统 TCP + TLS 1.3 需要 2-RTT\n  C->>S: 1. Initial [Client Hello + TLS KeyShare]\n  activate S\n  S-->>C: 2. Handshake [Server Hello + Finished]\n  deactivate S\n  Note over C: 已完成对称密钥协商，立即发送应用加密数据\n  C->>S: 3. 1-RTT Application Data [HTTP/3 GET /api]\n  S-->>C: 4. 1-RTT Application Data [HTTP/3 Response 200 OK]"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"网络丢包率下 HTTP/2 (TCP) 与 HTTP/3 (QUIC) 首屏加载耗时 (ms)\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"HTTP/2 (TCP Head-of-Line Blocking)\", \"HTTP/3 (QUIC Independent Streams)\"] },\n  \"xAxis\": { \"type\": \"category\", \"name\": \"网络丢包率\", \"data\": [\"0%\", \"1%\", \"2%\", \"5%\", \"10%\", \"15%\"] },\n  \"yAxis\": { \"type\": \"value\", \"name\": \"页面首屏耗时 (ms)\" },\n  \"series\": [\n    {\n      \"name\": \"HTTP/2 (TCP Head-of-Line Blocking)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#f97316\" },\n      \"data\": [320, 540, 890, 1650, 3400, 5800]\n    },\n    {\n      \"name\": \"HTTP/3 (QUIC Independent Streams)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#059669\" },\n      \"data\": [280, 310, 340, 420, 680, 950]\n    }\n  ]\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "BBR 拥塞控制算法建模与瓶颈带宽推演",
                "notion_id": "demo_network_bbr_congestion",
                "chart_id": "EX03-L02",
                "desc": "推导 BtlBw（瓶颈带宽）与 RTprop（最小往返时延）双参数模型，跳出传统丢包即拥塞误区。",
                "charts": {
                    "c1": {
                        "type": "wavedrom",
                        "code": "{\n  \"signal\": [\n    { \"name\": \"BBR 状态机\", \"wave\": \"2.3.4.5.\", \"data\": [\"Startup\", \"Drain\", \"ProbeBW\", \"ProbeRTT\"] },\n    { \"name\": \"充盈度\", \"wave\": \"1.0.1.0.\" },\n    { \"name\": \"PacingRate\", \"wave\": \"3.2.4.2.\", \"data\": [\"2.88x\", \"0.75x\", \"1.25x\", \"1.0x\"] }\n  ],\n  \"config\": { \"hscale\": 2 }\n}"
                    }
                }
            }
        ]
    },
    {
        "id": "G04",
        "dir": "examples/g04",
        "title": "分布式共识与容错架构",
        "tagline": "Raft 状态机、分布式事务与租约机制",
        "summary": "系统探讨在不可靠网络环境下实现强一致性共识的核心算法：Raft 领导者选举与日志复制、分布式两阶段提交（2PC/3PC）以及分布式锁与租约安全保证。",
        "accent": "#D97706",
        "tags": ["分布式系统", "Raft共识", "CAP定理", "两阶段提交"],
        "lectures": [
            {
                "id": "L01",
                "title": "Raft 算法领导者选举与日志复制安全保证",
                "notion_id": "demo_dist_raft_consensus",
                "chart_id": "EX04-L01",
                "desc": "详解任期（Term）、心跳超时与多数派投票机制，推导分布式线性一致性读的实现方案。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "sequenceDiagram\n  autonumber\n  participant L as 领导者 Leader (S1)\n  participant F1 as 跟随者 Follower (S2)\n  participant F2 as 跟随者 Follower (S3)\n  Note over L: 接收客户端写入请求 (cmd=SET k v)\n  L->>F1: 1. AppendEntries RPC [Term: 2, LogIndex: 101]\n  L->>F2: 2. AppendEntries RPC [Term: 2, LogIndex: 101]\n  activate F1\n  activate F2\n  F1-->>L: 3. AppendEntries OK (Success)\n  F2-->>L: 4. AppendEntries OK (Success)\n  deactivate F1\n  deactivate F2\n  Note over L: 达到半数以上确认 (Quorum=2/3) -> 提交日志\n  L-->>L: 5. 提交状态机 commitIndex=101\n  L->>F1: 6. 下次心跳同步 commitIndex=101\n  L->>F2: 7. 下次心跳同步 commitIndex=101"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"不同集群节点规模下 Raft 选主收敛时间分布 (ms)\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"xAxis\": { \"type\": \"category\", \"data\": [\"3 节点\", \"5 节点\", \"7 节点\", \"9 节点\"] },\n  \"yAxis\": { \"type\": \"value\", \"name\": \"选主耗时 (ms)\" },\n  \"series\": [\n    {\n      \"name\": \"平均选主耗时\",\n      \"type\": \"bar\",\n      \"barWidth\": \"40%\",\n      \"itemStyle\": { \"color\": \"#d97706\", \"borderRadius\": [6, 6, 0, 0] },\n      \"data\": [142, 185, 230, 310]\n    }\n  ]\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "两阶段提交 (2PC) 与 Paxos 选主收敛",
                "notion_id": "demo_dist_2pc_paxos",
                "chart_id": "EX04-L02",
                "desc": "剖析分布式事务协调者崩溃与网络分区下的阻塞盲区，推导 3PC 与 TCC 补偿方案。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart TD\n  subgraph PHASE1 [\"阶段一：准备阶段 (Prepare Phase)\"]\n    TC[\"事务协调者 (Coordinator)\"]\n    P1[\"参与节点 A (Participant)\"]\n    P2[\"参与节点 B (Participant)\"]\n    TC -->|Prepare| P1\n    TC -->|Prepare| P2\n    P1 -->|Vote Commit| TC\n    P2 -->|Vote Commit| TC\n  end\n  subgraph PHASE2 [\"阶段二：提交阶段 (Commit Phase)\"]\n    TC2[\"协调者决策\"]\n    TC2 -->|全局提交 Global Commit| P1\n    TC2 -->|全局提交 Global Commit| P2\n  end"
                    }
                }
            }
        ]
    },
    {
        "id": "G05",
        "dir": "examples/g05",
        "title": "高性能存储引擎与索引结构",
        "tagline": "LSM 树、B+ 树与分层存储架构",
        "summary": "对比现代主流存储引擎的底层索引结构：面向写优化的 LSM 树（MemTable/SSTable 压缩与布隆过滤器）与面向读优化的 B+ 树并发分裂控制，量化分析写放大与读放大权衡。",
        "accent": "#DC2626",
        "tags": ["存储引擎", "LSM-Tree", "B+树", "写放大分析"],
        "lectures": [
            {
                "id": "L01",
                "title": "LSM-Tree 写入流水线与 MemTable 刷盘机理",
                "notion_id": "demo_storage_lsm_tree",
                "chart_id": "EX05-L01",
                "desc": "详解 WAL 预写日志、跳表内存索引、SSTable 分层 Compaction 与 BloomFilter 加速原理。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart LR\n  subgraph WRITE [\"写入路径 (Write Path)\"]\n    REQ[\"写请求 Put(K, V)\"] --> WAL[(\"WAL 顺序追加写磁盘\")]\n    REQ --> MEM[\"MemTable 内存跳表\"]\n  end\n  subgraph FLUSH [\"刷盘与压缩 (Compaction)\"]\n    MEM -->|内存阈值冻结| IMM[\"Immutable MemTable\"]\n    IMM -->|后台刷盘 Flush| L0[\"SSTable Level 0\"]\n    L0 -->|Leveled Compaction| L1[\"SSTable Level 1\"]\n    L1 -->|归并排序压缩| L2[\"SSTable Level 2\"]\n  end"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"LSM-Tree 分层压缩写放大系数与读取延迟权衡\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"写放大系数 (Write Amplification)\", \"点查延迟 (P99 Read Latency ms)\"] },\n  \"xAxis\": { \"type\": \"category\", \"data\": [\"Size-Tiered\", \"Level-0\", \"Level-1\", \"Level-2\", \"Level-3\"] },\n  \"yAxis\": [\n    { \"type\": \"value\", \"name\": \"写放大倍数\", \"max\": 40 },\n    { \"type\": \"value\", \"name\": \"P99 读取延迟 (ms)\", \"max\": 15 }\n  ],\n  \"series\": [\n    {\n      \"name\": \"写放大系数 (Write Amplification)\",\n      \"type\": \"bar\",\n      \"itemStyle\": { \"color\": \"#dc2626\" },\n      \"data\": [4.2, 8.5, 14.1, 22.8, 32.5]\n    },\n    {\n      \"name\": \"点查延迟 (P99 Read Latency ms)\",\n      \"type\": \"line\",\n      \"yAxisIndex\": 1,\n      \"itemStyle\": { \"color\": \"#3b82f6\" },\n      \"data\": [12.4, 6.2, 3.1, 1.8, 1.2]\n    }\n  ]\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "B+ 树节点分裂算法与磁盘扇区 I/O 对齐",
                "notion_id": "demo_storage_bplus_tree",
                "chart_id": "EX05-L02",
                "desc": "推导 B+ 树扇出率（Fan-out）、树高与磁盘 4KB 扇区对齐的几何级数关系。",
                "charts": {
                    "c1": {
                        "type": "wavedrom",
                        "code": "{\n  \"signal\": [\n    { \"name\": \"页缓存锁状态\", \"wave\": \"0.2.0.2.0.\", \"data\": [\"读锁\", \"读锁\"] },\n    { \"name\": \"分裂触发信号\", \"wave\": \"0...1.0...\" },\n    { \"name\": \"写锁升级\", \"wave\": \"0...2.0...\", \"data\": [\"排他写锁\"] }\n  ],\n  \"config\": { \"hscale\": 2 }\n}"
                    }
                }
            }
        ]
    },
    {
        "id": "G06",
        "dir": "examples/g06",
        "title": "云原生网格与全链路可观测性",
        "tagline": "eBPF 内核探测、服务网格与可观测性",
        "summary": "探索现代云原生基础设施观测底座：利用 eBPF 技术在 Linux 内核层实现无侵入性能剖析，结合 W3C TraceContext 与 OpenTelemetry 规范构建微服务分布式追踪链路。",
        "accent": "#0891B2",
        "tags": ["云原生", "eBPF", "服务网格", "分布式追踪"],
        "lectures": [
            {
                "id": "L01",
                "title": "eBPF 动态挂载与 Linux 内核探测流水线",
                "notion_id": "demo_cloud_ebpf_observability",
                "chart_id": "EX06-L01",
                "desc": "深入 kprobe、tracepoint 与 BPF 环形缓冲区（RingBuffer），实现零侵入纳秒级函数探针。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "flowchart TD\n  subgraph USER [\"用户态 User Space\"]\n    APP[\"业务应用 Application\"]\n    LOADER[\"eBPF 采集器 / 控制器\"]\n    MAP_USER[\"用户态读取 BPF Maps / RingBuffer\"]\n  end\n  subgraph KERNEL [\"Linux 内核态 Kernel Space\"]\n    SYS[\"系统调用 sys_enter_write\"]\n    BPF_PROG[\"eBPF 字节码探针 (kprobe/tracepoint)\"]\n    VERIFIER[\"内核静态验证器 (Verifier)\"]\n    JIT[\"JIT 即时编译成机器码\"]\n    MAPS[(\"高效共享内存 BPF Map\")]\n  end\n  LOADER -->|bpf 系统调用载入| VERIFIER\n  VERIFIER --> JIT --> BPF_PROG\n  SYS -->|触发 Hook| BPF_PROG\n  BPF_PROG -->|无锁更新计数| MAPS\n  MAPS --> MAP_USER"
                    },
                    "c2": {
                        "type": "echarts",
                        "code": "{\n  \"title\": { \"text\": \"传统 APM 探针 vs eBPF 内核探针 CPU 开销对比 (%)\" },\n  \"tooltip\": { \"trigger\": \"axis\" },\n  \"legend\": { \"data\": [\"传统 JVM/Node Agent 探针 (5.8%)\", \"eBPF 内核探测器 (0.4%)\"] },\n  \"xAxis\": { \"type\": \"category\", \"data\": [\"10k QPS\", \"20k QPS\", \"50k QPS\", \"100k QPS\", \"200k QPS\"] },\n  \"yAxis\": { \"type\": \"value\", \"name\": \"额外 CPU 消耗百分比 (%)\" },\n  \"series\": [\n    {\n      \"name\": \"传统 JVM/Node Agent 探针 (5.8%)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#f43f5e\" },\n      \"data\": [1.8, 3.2, 5.8, 9.4, 15.6]\n    },\n    {\n      \"name\": \"eBPF 内核探测器 (0.4%)\",\n      \"type\": \"line\",\n      \"smooth\": true,\n      \"itemStyle\": { \"color\": \"#0891b2\" },\n      \"data\": [0.2, 0.3, 0.4, 0.7, 1.1]\n    }\n  ]\n}"
                    }
                }
            },
            {
                "id": "L02",
                "title": "分布式链路追踪与 W3C TraceContext 跨进程传播",
                "notion_id": "demo_cloud_trace_context",
                "chart_id": "EX06-L02",
                "desc": "基于 traceparent 与 tracestate 标准请求头，推导全链路拓扑还原与关键路径分析算法。",
                "charts": {
                    "c1": {
                        "type": "mermaid",
                        "code": "sequenceDiagram\n  autonumber\n  participant GW as API 网关 Gateway\n  participant ORD as 订单服务 OrderService\n  participant PAY as 支付服务 PaymentService\n  Note over GW: 生成 trace-id: 4bf92f3577b34da6a3ce929d0e0e4736\n  GW->>ORD: HTTP POST /orders (Header: traceparent)\n  activate ORD\n  Note over ORD: 继承 trace-id，生成 span-id: 00f067aa0ba902b7\n  ORD->>PAY: gRPC ProcessPayment (Context Propagation)\n  activate PAY\n  Note over PAY: 跨进程传播成功，记录支付耗时\n  PAY-->>ORD: gRPC Response OK\n  deactivate PAY\n  ORD-->>GW: HTTP Response 201 Created\n  deactivate ORD"
                    }
                }
            }
        ]
    }
]

print(f"[*] 开始生成纯净演示课程组体系: 共 {len(DEMO_GROUPS)} 组...")

for g in DEMO_GROUPS:
    g_dir = BUFFER_DOCS / g["dir"]
    g_dir.mkdir(parents=True, exist_ok=True)
    
    # 1. 生成课程组 index.md (标准使用 <GroupIndex /> 全套组件)
    index_md_content = f"""---
title: "{g['id']} · {g['title']}"
description: "{g['summary']}"
outline: false
sidebar: false
aside: false
---

<GroupIndex />
"""
    (g_dir / "index.md").write_text(index_md_content, encoding="utf-8")

    # 2. 生成各讲正文与图表 sidecar
    for idx, l in enumerate(g["lectures"]):
        next_lecture = g["lectures"][idx + 1] if idx + 1 < len(g["lectures"]) else None
        
        # 写图表 sidecar JSON
        chart_file = CHARTS_DIR / f"{l['chart_id']}.json"
        chart_file.write_text(json.dumps(l["charts"], indent=2, ensure_ascii=False), encoding="utf-8")
        if l["chart_id"] == "EX-L01":
            ex_chart_dir = BUFFER_DOCS / "examples" / "public" / "charts"
            ex_chart_dir.mkdir(parents=True, exist_ok=True)
            (ex_chart_dir / "EX-L01.json").write_text(json.dumps(l["charts"], indent=2, ensure_ascii=False), encoding="utf-8")
        
        # 组装讲义正文
        fig_blocks = ""
        for cid, cdef in l["charts"].items():
            fig_blocks += f'\n<figure class="chart" data-lecture="{l["chart_id"]}" data-id="{cid}" data-type="{cdef["type"]}"></figure>\n'

        if next_lecture:
            next_preview = f"""## 下一讲预告

完成本讲的学习后，我们已经建立起「{l['title']}」的核心心智模型。

在下一讲 **[{next_lecture['title']}](./{next_lecture['id']}.md)**（对应节点 `{next_lecture['notion_id']}`）中，我们将继续深入拓展更复杂的工程场景与分布式演进挑战，探索如何在高并发、高可用与强一致性之间寻找最佳工程平衡点。
"""
        else:
            next_preview = f"""## 下一讲预告

恭喜完成本模块的深度推演！我们已经全面剖析了「{l['title']}」的底层原理与工程实践。

在下一讲中，我们将跨越到更高维度的系统架构协同体系，探索分布式系统与云原生基础设施的更广阔天地。
"""

        scope_sec = ""
        if g["id"] == "G01" and l["id"] == "L01":
            scope_sec = """### 2. 虚拟示波器：阶跃响应与时域瞬态演化

在高速信号传输与供电轨瞬态突发过程中，寄生参数与储能元件在时域上的动态响应可通过示波器直观观测：

<div class="scope-viewer" v-pre>
  <div class="scope-header">
    <div><strong>TRANSIENT STEP RESPONSE ANALYSIS</strong> ｜ RC Charging &amp; Parasitic Drop Breakdown</div>
    <div>
      <span class="scope-ch1">■ CH1: 激励脉冲 V<sub>in</sub> (阶跃激励)</span> &nbsp;&nbsp;&nbsp;&nbsp;
      <span class="scope-ch2">■ CH2: 响应波形 V<sub>out</sub> (积分响应)</span>
    </div>
  </div>
  <svg class="scope-svg" viewBox="0 0 680 270">
    <!-- Screen rectangle & grid -->
    <rect x="60" y="15" width="540" height="205" fill="#050914" stroke="#334155" stroke-width="1.5" rx="4" />
    <line x1="60" y1="50" x2="600" y2="50" stroke="#1e293b" stroke-width="1" stroke-dasharray="2,3" />
    <line x1="60" y1="110" x2="600" y2="110" stroke="#1e293b" stroke-width="1" stroke-dasharray="2,3" />
    <line x1="60" y1="160" x2="600" y2="160" stroke="#1e293b" stroke-width="1" stroke-dasharray="2,3" />
    <line x1="60" y1="220" x2="600" y2="220" stroke="#334155" stroke-width="1.5" />
    <line x1="160" y1="15" x2="160" y2="220" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3,3" opacity="0.6" />
    <line x1="440" y1="15" x2="440" y2="220" stroke="#f59e0b" stroke-width="1" stroke-dasharray="3,3" opacity="0.6" />
    <!-- Safe & Threshold lines -->
    <line x1="60" y1="65" x2="600" y2="65" stroke="#10b981" stroke-width="1" stroke-dasharray="4,2" opacity="0.7" />
    <text x="605" y="68" font-size="9" fill="#10b981" font-family="monospace">V_high (3.3V 门限)</text>
    <line x1="60" y1="185" x2="600" y2="185" stroke="#ef4444" stroke-width="1" stroke-dasharray="4,2" opacity="0.7" />
    <text x="605" y="188" font-size="9" fill="#ef4444" font-family="monospace">V_low (参考零线)</text>
    <!-- X labels -->
    <text x="60" y="235" font-size="10" fill="#94a3b8" text-anchor="middle" font-family="monospace">0</text>
    <text x="160" y="235" font-size="10" fill="#f59e0b" text-anchor="middle" font-family="monospace">t_0 (激励前沿)</text>
    <text x="300" y="235" font-size="10" fill="#94a3b8" text-anchor="middle" font-family="monospace">过渡过程 Δt = 5τ</text>
    <text x="440" y="235" font-size="10" fill="#f59e0b" text-anchor="middle" font-family="monospace">t_1 (激励后沿)</text>
    <!-- CH1 Trace: Step Input -->
    <path d="M 60,185 L 160,185 L 160,65 L 440,65 L 440,185 L 600,185" fill="none" stroke="#38bdf8" stroke-width="2" />
    <text x="65" y="42" font-size="9" fill="#38bdf8" font-weight="bold">CH1: 阶跃输入脉冲 V_in</text>
    <!-- CH2 Trace: Exponential curve -->
    <path d="M 60,185 L 160,185 Q 220,95 440,65 L 440,65 Q 490,165 600,185" fill="none" stroke="#fbbf24" stroke-width="2.5" />
    <text x="65" y="85" font-size="9" fill="#fbbf24" font-weight="bold">CH2: 积分电容响应 V_out</text>
    <!-- Callouts -->
    <rect x="220" y="115" width="165" height="20" rx="3" fill="#1e293b" stroke="#fbbf24" stroke-width="1" />
    <text x="225" y="129" font-size="8.5" fill="#fef08a" font-family="monospace">指数充电: V(t) = V_0(1 - e^{-t/τ})</text>
    <rect x="460" y="125" width="135" height="20" rx="3" fill="#1e293b" stroke="#10b981" stroke-width="1" />
    <text x="465" y="139" font-size="8.5" fill="#86efac" font-family="monospace">自然泄放: V(t) = V_0 · e^{-t/τ}</text>
  </svg>
</div>
"""
            math_title = "### 3. 数学建模与量化推导"
        else:
            math_title = "### 2. 数学建模与量化推导"

        math_sec = f"""{math_title}

系统的稳态吞吐与性能表现可以通过经典排队论与网络拓扑公式精确建模：

对于由 \\( N \\) 个节点组成的协同系统，假设每个节点的平均处理延迟为 \\( \\tau \\)，在无冲突网络环境下的理论最大并行吞吐满足利特尔法则（Little's Law）：

$$ L = \\lambda \\cdot W $$

其中 \\( L \\) 表示系统内部平均并发请求数，\\( \\lambda \\) 为到达速率，\\( W \\) 为平均驻留时间。当并发规模跨越边界时，锁竞争与缓存同步将导致实际加速比受到阿姆达尔定律（Amdahl's Law）的硬性约束：

$$ S_{{\\text{{latency}}}}(s) = \\dfrac{{1}}{{(1 - p) + \\dfrac{{p}}{{s}}}} $$

式中 \\( p \\) 为代码中可完全并行化的比例，\\( s \\) 为计算核心加速因子。这解释了为何盲目增加节点往往无法带来线性的吞吐增长。
"""

        lecture_content = f"""---
title: "第{int(l['id'][1:])}讲 · {l['title']}"
order: {int(l['id'][1:])}
description: "节点 `{l['notion_id']}` ｜ 课程组: {g['id']} ｜ 难度 ★★★ ｜ 预估 45min ｜ 前置: 系统基础"
outline: deep
---

# 第{int(l['id'][1:])}讲 · {l['title']}

> 节点 `{l['notion_id']}` ｜ 课程组: {g['id']} ｜ 难度 ★★★ ｜ 预估 45min

## 开篇思考：工程约束与核心挑战

在现代高性能系统工程实践中，任何高层抽象的便利性都是建立在对底层物理约束的精确妥协之上的。

理解「{l['title']}」，不仅需要我们掌握经典算法与数据结构，更要求我们穿透抽象层，洞察系统在时间、空间与容错边界上的本质权衡。

本讲立足于工业界成熟架构标准与权威技术规范（参考 <span class="cite" data-cite="https://tools.ietf.org" title="https://tools.ietf.org">RFC 标准规范</span> 与原厂工程实践），用可交互、可量化、可验证的方式展开系统推演。

---

## 核心架构推演与原理解析

### 1. 系统动态模型与时序交互

在系统运转过程中，各个参与方与状态组件遵循严谨的状态迁移机理：

{fig_blocks}
{scope_sec}
{math_sec}

### 4. 核心工程实现示例

```c
// 经典工程状态量化计算与参数推导
float calculate_system_metric(float input_val, float scale_factor) {{
    if (scale_factor <= 0.0f) return 0.0f;
    return input_val / scale_factor;
}}
```

---

## 心智模型与工程自测

**自测 1（系统行为与瓶颈判定）**：结合上述交互时序与状态迁移模型，当系统遭遇网络瞬时抖动或单节点短暂停顿时，最先饱和的组件是什么？如何规避雪崩效应？

::: details 点击查看自测 1 深度解析
- **参考答案与核心要点**：
  1. **瓶颈判定**：在网络抖动期间，客户端未完成请求将在连接池与接收队列中积压，导致内存缓冲区（Buffer Pool）迅速攀升；
  2. **雪崩规避**：必须在调用链路前端配置自适应熔断（Circuit Breaker）与带抖动的指数退避重试（Exponential Backoff with Jitter），防止重试风暴直接打垮下游。
:::

---

{next_preview}
"""
        (g_dir / f"{l['id']}.md").write_text(lecture_content, encoding="utf-8")

print(f"[+] 讲义与图表 sidecar JSON 全部生成完毕！")

# 3. 更新 groups.example.mts
groups_mts_code = f"""/**
 * groups.example.mts — 纯净通用的现代系统架构与软件工程演示体系 (6 课程组 / 12 讲 / 28 交互图表)
 */

export type GroupMeta = {{
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  temp?: boolean
}}

export const SITE_META = {{
  name: '现代系统架构与工程体系',
  text: '可交互工程讲义引擎 · 演示系统',
  tagline: '从底层微架构、现代语言运行时与网络协议，到分布式共识、高性能存储与云原生可观测性 —— 原生可交互式知识演进网络',
}} as const

export const SITE_FEATURES: {{ title: string; details: string }}[] = [
  {{
    title: '图表原生可交互',
    details: '内联视图只看不操作：点一下图表即进入全屏放大，无缝自适应整幅；缩放与拖动在全屏层进行。ECharts 悬停看数值、点图例开关数据线，WaveDrom 时钟沿对齐。',
  }},
  {{
    title: '沉浸式阅读',
    details: '一键收起导航与大纲，版心放宽、行距上调；状态本地记忆，跨页面自动保持。',
  }},
  {{
    title: '构建期 KaTeX 公式',
    details: 'LaTeX 在构建期由 KaTeX 渲染成 HTML，首屏零闪烁；点击公式直接复制 TeX 源码。',
  }},
  {{
    title: '出版级打印导出',
    details: '右上角常驻导出浮层，支持 A4 跨页防截断多页 PDF 与超长全景 Canvas 切片导出。',
  }},
  {{
    title: '内容与引擎物理解耦',
    details: '引擎只带结构，讲义放置于独立内容源按需挂载；同一套引擎承载任意学科，私有数据绝不入库。',
  }},
]

export const GROUPS: GroupMeta[] = [
"""
for g in DEMO_GROUPS:
    groups_mts_code += f"""  {{
    id: '{g['id']}',
    dir: '{g['dir']}',
    title: '{g['title']}',
    tagline: '{g['tagline']}',
    summary: '{g['summary']}',
    accent: '{g['accent']}',
    tags: {json.dumps(g['tags'], ensure_ascii=False)},
  }},
"""
groups_mts_code += f"""]

export const GROUP_META: GroupMeta[] = GROUPS
"""

(BUFFER_DOCS / ".vitepress" / "groups.example.mts").write_text(groups_mts_code, encoding="utf-8")
print(f"[+] groups.example.mts 已更新为完整的 6 组系统架构体系！")
