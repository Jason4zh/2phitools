# osu!mania → Phigros 谱面转换器

把 osu!mania 的 `.osu` / `.osz` / Malody `.mcz` 转成 Phigros 可读的 **PEC**（`.pec`），并可直接打包成 Phira 谱面包。

## 打开方式

用任意浏览器打开本目录下的 `index.html`（`file://` 直接打开即可，不需要服务器）。

## 三个页签

### 1. 搜索谱面
- 关键词（歌名 / 曲师 / 谱师）→ 搜索
- 默认两个数据源，**均已实测可用**：
  - `sayobot`：`https://api.sayobot.cn/?post`（国内镜像，列表不带难度，会再逐个补 `beatmapinfo`）
  - `osu.direct`：`https://osu.direct/api/search?q={q}&m=3&ps=50`（官方数据镜像，一次返回全部难度）
- 结果里只显示**含 osu!mania 难度**的谱面集，每个难度是一个按钮（键数 / 难度名 / 星级）
- 点单个难度 = 只转这个难度；点「全部 N 个难度」= 整包都转
- 也可以直接粘贴谱面集链接或 ID 下载

### 2. 本地文件
选 `.osu` 或 `.osz` / `.mcz`（zip 包），本地解析转换，不联网。

### 3. 设置
- 搜索接口 / 下载接口 / CORS 代理 / osu! 官方 OAuth（可选）
- 转换参数：轨道宽度占比、判定线 Y、流速、偏移 ms、`finish` 音效是否转 Flick

## 输出

单谱面：`歌名 [难度].pec`
打包：`歌名 [难度]_phi.zip`，内含

```
chart.pec     转换后的谱面
music.mp3     音频（自动从 osz 里找）
bg.jpg        曲绘（有则带）
info.yml      Phira 谱面包元数据
```

整个 zip 可以直接丢进 Phira 导入。

## 格式要点（转换依据）

- PEC 首行固定 `175`
- `bp 拍数 bpm`、`cp 线号 拍数 x(0~2048) y(0~1400)`、`ca` 透明度、`cv` 流速
- 音符：`n1` Tap、`n4` Drag、`n3` Flick、`n2` Hold；x 范围 ±1024
- 每个音符行后面必须跟 `# 速度` 与 `& 宽度` 两行
- 拍数以四分音符计，音频 0 秒 = 拍 0；BPM 变化按 uninherited 时间点分段换算

## 已知限制

- 只处理 osu!mania（`Mode: 3`），std/taiko/catch 会跳过
- Malody 原生 `.mc` 不支持（不是 zip）
- 转出来的谱只是「可玩、可控」，判定线不加特效；需要演出效果请在 Re:PhiEdit / Phira 里继续编辑
- 建议等级由 NPS 估算（`6.2 + 2.75·log2(NPS)`，短谱微降），仅供参考

## 文件结构

```
index.html          界面
app.js              搜索 / 下载 / 打包
core.js             纯逻辑：parseOsu → buildPec → info.yml
src/core.js         同上（源副本）
lib/jszip.min.js    解压 osz / mcz
_test/              本地回归测试素材
```
