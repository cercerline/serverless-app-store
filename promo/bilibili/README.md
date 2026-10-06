# B 站宣传片生成器

一条命令生成带中文配音的 1080p 宣传片，**不需要任何账号、API 密钥、剪辑软件或转码工具**。

```
promo/bilibili/
  make-voiceover.mts   生成配音（用 Windows 自带的中文语音合成）
  voiceover.js         生成物：内嵌 base64 音频 + 时间轴
  script.md            生成物：分镜脚本 + B 站投稿信息
  qr-encoder.js        二维码编码器（从 animation.html 提取）
  video.html           ← 双击打开这个
```

---

## 三步出片

### 1. 生成配音

```
npm run video:voice
```

用系统自带的中文语音合成（Microsoft Huihui）朗读 10 段旁白，输出到 `voiceover.js`。
**不需要联网。**

想改台词：编辑 `make-voiceover.mts` 里的 `SCENES` 数组，重新跑一次。

想换音色或语速：

```
$env:TTS_RATE=2; npm run video:voice      # 语速 -10 到 10
$env:TTS_VOICE="其他音色名"; npm run video:voice
```

查看系统里有哪些中文音色：

```powershell
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
  ForEach-Object { $_.VoiceInfo } | Select-Object Name, Gender, Culture
```

### 2. 录制

**双击打开 `promo/bilibili/video.html`**（用 Edge 或 Chrome）

1. 点 **「先预览一遍」** —— 不录制，先看效果，随时可重来
2. 满意后点 **「开始录制」** —— 页面播放一遍并录制，**不要切换标签页**
3. 播完自动下载 `xiaokaiqi-bilibili.mp4`

### 3. 上传

MP4 直接传 B 站。投稿信息（标题/简介/标签/分区）在 `script.md` 里，复制即可。

---

## 封面图

打开这个地址，得到一张干净的 1920×1080 画面，截屏即可当封面：

```
video.html?t=55&clean=1
```

- `t=` 秒数。参考时刻：`21` 站点登场 · `28` 上传解析 · `50` 应用墙 · `55` 二维码
- `clean=1` 隐藏页面上所有按钮和说明

想一次看完所有分镜：

```
video.html?t=list
```

然后按 **空格** 逐个切换。

---

## 为什么是「录制」而不是「导出」

浏览器没有「把 canvas 渲染成视频文件」的接口，但可以一边渲染一边录
（`canvas.captureStream()` + `MediaRecorder`）。

这样做的实际好处：

| | 录制方案 | 装 ffmpeg 渲染方案 |
|---|---|---|
| 依赖 | 只需浏览器 | 要装 ffmpeg（约 80MB） |
| 中文字体 | 系统字体直接可用 | 要单独指定字体文件 |
| 画质 | 与屏幕所见一致 | 取决于渲染管线 |
| 音画同步 | 由 AudioContext 时钟保证 | 要对齐时间轴 |

配音通过 `createMediaStreamDestination()` 混入录制流，所以**不需要录屏权限**，
也不会有麦克风环境噪音——录进去的只有配音本身。

**格式**：新版 Chromium 内核的 `MediaRecorder` 支持 H.264 + AAC 的 MP4，
所以录出来直接就是 B 站原生格式。旧浏览器会自动退回 WebM。

---

## 自检

```
npm run check:seeds         # 检查 seed-apps 里的 HTML 应用
npm run check:recorder      # 实测浏览器能否录出带声音的视频
```

`check:recorder` 会在无头浏览器里真的录 4 秒，然后检查产出的文件里
**是否同时含有视频轨和音频轨**——只看文件大小会被「有画面没声音」骗过去。

> 注意：不要用 `--virtual-time-budget` 测试录制。虚拟时钟会让定时器瞬间跳过，
> 而媒体编码是按真实时间进行的，结果会误报为 0 字节。

---

## 时间轴

配音总长约 **64 秒**，10 个分镜：

| # | 起 | 分镜 | 画面 |
|---|---|---|---|
| 1 | 0.0s | hook | 用 AI 做的 app，然后呢？ |
| 2 | 3.7s | pain-phone | app 困在一台手机里，发送失败 |
| 3 | 10.9s | pain-store | 上架的三道关卡依次被否 |
| 4 | 18.9s | reveal | 站点登场 |
| 5 | 23.5s | upload | 文件飞入，字段逐条解析出来 |
| 6 | 33.3s | webapp | 浏览器里直接跑，旁边是手机 |
| 7 | 39.0s | nocost | 三个对勾 + 分享卡片 |
| 8 | 45.7s | catalogue | 10 个应用卡片铺开 |
| 9 | 54.6s | cta | 网址 + 二维码 |
| 10 | 59.5s | outro | 收尾 |

帧号与配音时长由 `voiceover.js` 驱动——**先定配音，画面跟着配音走**，
而不是先画好再硬凑时间。

---

## 想改画面

编辑 `video.html` 里的 `DRAW` 对象，每个分镜一个函数：

```js
DRAW.hook = function (t, d) {
  // t = 该分镜内的秒数（从 0 开始）
  // d = 该分镜的总时长
};
```

常用工具函数：`bg()` `grid()` `panel()` `text()` `logo()` `drawQr()`。

**改完记得同步配音**：如果画面时长变了但配音没变，两者会对不上。
需要更长的画面时，改 `make-voiceover.mts` 里对应分镜的台词长度（台词越长，配音越长）。
