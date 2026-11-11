# 云枢监控实况（shuyun）

在 DSH 顶部（和日期同一行）显示一个常驻徽标，实时告诉你 **云枢（Yunshu / 鹰云 SASE）此刻正在对这台 Mac 做什么**：
截屏、录屏抓屏、录音、摄像头、键盘监听、扫描文件、读剪贴板、采集软件清单、往服务端上报……
点开徽标可以看到「此刻正在做」和「最近动作」两段流水。

> 这是只读的观察工具：它不去关闭、拦截或绕过云枢，只把系统里已经发生的访问行为翻译成人话。

## 名字说明

- 包名是 **`dsh-shuyun`**（DSH 前缀 + 枢云），描述里仍然写 **云枢（Yunshu）**——指的是同一个东西。
- 0.1.x 叫 `yunshu-watch`，0.2.0 起改名叫 `shuyun`，0.3.5 起统一成 `dsh-shuyun`（跟随生态惯例）：模块 id、HTTP 路由（`/api/yunshu-watch/state` → `/api/shuyun/state`）、状态目录、SwiftBar 脚本名一并改成 `shuyun`。
- 升级路径：旧版本会在 `~/Library/Application Support/yunshu-watch/` 留一个状态目录、在 SwiftBar 里留一个 `yunshu-watch.2s.sh`。新版本启动时会**自动删掉旧脚本**（避免菜单栏挂着两个条目），旧目录可以手动删除。

## 两块显示面（SwiftBar 是可选的）

插件有两条互不依赖的显示通道：

| 入口 | 在哪 | 需要 SwiftBar 吗 |
| --- | --- | --- |
| **DSH 顶栏徽标** | DSH 窗口顶部、日期同一行的右侧，点开看「此刻正在做 / 最近动作」 | ❌ 不需要 |
| **macOS 菜单栏条目** | 系统菜单栏常驻图标（不打开 DSH 也能瞟一眼） | ✅ 需要 |

**不装 SwiftBar 完全可用**：采集器、`/api/shuyun/state` 接口、顶栏徽标都照常工作，只是少一个菜单栏图标。插件只有在 `~/Library/Application Support/SwiftBar/Plugins` 目录**存在**时才会往里写 `shuyun.2s.sh`，否则安静跳过、不创建任何目录。

想彻底不要菜单栏条目：卸载 SwiftBar，或删掉那个脚本（插件下次启动会重建，除非目录不存在）。

## 它凭什么知道

| 证据源 | 说明 | 能看到什么 |
| --- | --- | --- |
| macOS TCC 统一日志（`log stream`） | 系统自己记录「哪个进程在申请屏幕录制 / 麦克风 / 摄像头 / 键盘监听 / 全盘文件 / 无障碍」。只保留责任进程或访问进程命中 `eagleyun` / `yunshu` 的记录 | 截屏、录音、摄像头、键盘监听、模拟键鼠、全盘文件访问、读取界面元素 |
| 云枢 agent 日志 `~/Library/Logs/com.eagleyun.sase/agent/*.log` | 云枢自己写的运行日志，1 秒增量跟随 | 截屏开关状态、定时抓屏、水印/前台应用、剪贴板读写（含内容类型与字节数）、**读取前台浏览器地址**、**各浏览器窗口数**、软件清单、心跳上报 |
| 云枢 DLP 引擎日志 `/opt/.yunshu/logs/sase.dlp.engine.log` | 内容扫描器打印的待扫描文件 | 正在扫描的具体文件路径 |
| 进程表（`ps`） | 云枢守护进程是否在线、远程协助服务是否在跑 | 在线状态、进程数 |

所有采集都在本机、内存里完成，只保留最近 60 条动作流水，不落盘、不外发；只写三个状态文件到 `~/Library/Application Support/shuyun/`（`menubar.txt`、`menu.txt`、`state.json`）。

## 面板上的动作是怎么来的

几个容易被误解的条目，对应到日志里是这样：

| 面板显示 | 日志证据 | 实际含义 |
| --- | --- | --- |
| **读取浏览器地址** | `ClipboardMonitor: … getUrlWithCode:com.google.Chrome`，约 2–3 秒一次 | 云枢在轮询**前台浏览器的当前地址**。日志只记浏览器标识，**不记 URL 明文** |
| **统计浏览器窗口** | `[BrowserWindowState] reply state:{ chrome = { window_count = 4 } }`，约 60 秒一次 | 各浏览器开了几个窗口，会汇总成「Chrome 4 个窗口 · Edge 1 个窗口」 |
| **读取剪贴板** | `pb changed` / `pb item, length: N, type: public.tiff` | 剪贴板内容变化，以及写入内容**类型与字节数**（不读内容本身） |
| **跟踪前台应用** | `frontmost bundle id:com.openai.codex` | 前台应用切换 |
| **扫描文件内容** | DLP 引擎日志 `ScanFile Result: filename: …` | 正在被内容扫描的文件路径 |

> 注意：这些日志只记录「读了什么类型的东西」，不记录内容。浏览器地址、剪贴板文本都不落盘。


## 安装

```sh
dsh plugin add dsh-shuyun
```

装完**重启 DSH**（客户端模块需要重新加载），顶栏日期右边就会出现徽标。

### 前置条件（缺一个就用不了）

| # | 前提 | 不满足会怎样 |
| --- | --- | --- |
| 1 | **macOS**（Intel / Apple Silicon 都行） | 代码硬依赖 `/usr/bin/log`、`/bin/ps -axo`、`stat -f` 和 macOS TCC 子系统；`package.json` 已声明 `os: darwin`，其它平台装不上 |
| 2 | **DSH Desktop，或带 web 服务的 `dsh web`** | 插件注入 `webServer` + `connection`；headless / ACP / SDK 这类没有 web 层的 profile 里不会激活 |
| 3 | **DSH 核心 `>=0.2.2-alpha.2 <0.3.0`** | 写在 `dsh.engines` 里，不满足会被安装门禁拦下 |
| 4 | **这台 Mac 已安装云枢（Yunshu / 鹰云 SASE）客户端并在运行** | 数据全部来自云枢自己的日志与进程；没有云枢 = 一个空面板 |
| 5 | **当前用户能读云枢日志目录** | 企业默认 644 可读；若 IT 收紧权限，面板会显示「云枢日志缺失」 |

### 不需要的东西

- ❌ 不需要 root
- ❌ 不需要给插件任何 TCC 权限（屏幕录制 / 辅助功能都不用）
- ❌ 不需要 API key、账号、云端服务
- ❌ 不需要联网（采集与展示全在本机完成）

### 装完怎么确认通了

点开顶栏徽标，看最后一行：

| 显示 | 含义 |
| --- | --- |
| `权限日志已连接 · 云枢日志已连接` | 全通，能看到 TCC 类和云枢日志类的全部动作 |
| `云枢日志缺失` | 读不到 `~/Library/Logs/com.eagleyun.sase/agent/`，通常是没有云枢或权限被收紧 |
| `权限日志：unavailable` | `log stream` 被系统/MDM 限制，原因显示在 `tccReason` 里 |
| 徽标显示「未连接」 | DSH 没跑，或插件没启动 |

## 安装位置与入口

- 服务端入口：`src/index.js`（Cordis 插件，暴露 `GET /api/shuyun/state`）
- 采集器：`src/collector.js`（纯 Node，可单独跑：`npm run probe`）
- 客户端入口：`lib/client.js`（已构建的单文件模块，注册到 `conversation.session.header.utilities`）

## 已知边界

- **TCC 日志是「访问申请」而不是「正在录制」的精确开关**：云枢每轮询一次键盘、每抓一次屏都会留一条记录，所以徽标显示的是「最近一次同类动作 + 距今多久」，而不是实时视频流状态。
- 只有当云枢把动作写进日志或申请系统权限时才可见；纯内存里的静默采集（如果存在）看不到。
- 云枢日志若被清理或改版导致行格式变化，对应动作会消失，徽标会退回「静默」——不会伪造动作。
- 摄像头 / 麦克风通常要真正使用时才会出现 TCC 记录，平时看不到属正常。

## 卸载

在「工作台 → 已安装」移除 `dsh-shuyun`，然后手动清掉两处残留：

```sh
rm -rf "$HOME/Library/Application Support/shuyun"
rm -f  "$HOME/Library/Application Support/SwiftBar/Plugins/shuyun.2s.sh"
```

它不联网、不上传任何数据，但确实会在本机写上面那三个状态文件。
