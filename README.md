# AppleTV AI Subtitles

给 Apple TV App 补上中文字幕的 **Loon 插件 + 可选自建字幕网关**。由 JerseyRiver 整理和维护，基于 DualSubs 修改，与 Codex 协作开发。不是 Apple、DualSubs 或 iRingo 官方项目。

最初为缺少中文字幕的电影做的实用工具。此前个人版的播放与字幕路径在 macOS 和 iPhone 上做过实测；公开版改为从 Loon 参数读取 API Key 后，目前通过了参数传递与模拟 API 请求测试，**尚未完成真实 Loon 上的参数输入 → Gemini 请求端到端验证**。不同影片、地区、系统和播放器行为仍可能不同；这是实验性项目，**不承诺所有影片都可用或逐句精准**。

## 能做什么

- 有独立英文 WebVTT 字幕：调用你自己的 Gemini API 翻译，保留字幕时间点，支持中英双语或仅译文。
- 仅有内嵌隐藏式字幕（CC）：可选用你自己的服务器，从 SubDL 搜索外部字幕，利用 Apple CC 尝试校时；同版本中文可用时使用现成中文，否则翻译选中的英文字幕。
- 新增字幕轨默认不自动选择。需要在播放器中手动选“翻译字幕”或“外部中文字幕”。
- 已完成的翻译持久缓存：Loon 设备端最多 20 份字幕；服务器默认最多 200 份成品，另有候选/参考缓存。不自动同步设备端缓存。
- 不修改 Apple 账号地区、商店和首页。公开插件规则只匹配 Apple 相关播放地址，不为 Netflix 等其他视频 App 启用翻译。直播字幕列表跳过 Gemini 翻译。

## 安装 Loon 插件

复制下面的完整 URL，作为 Loon 的插件订阅地址（代码框右上角可一键复制）：

```text
https://raw.githubusercontent.com/JerseyRiver/AppleTV-AI-Subtitles/main/plugin/AppleTV.AI.Subtitles.plugin
```

1. 在 Loon 的插件管理中，通过 URL 添加上面的地址。此插件会自动下载仓库中的 JS，不需要单独放置 JS 文件。
2. 按 Loon 的要求启用相关脚本、重写和 MITM，并安装及信任其证书。MITM 会让 Loon 处理这些域名的 HTTPS 内容，请理解其风险。
3. 在插件参数中填写自己的 `GeminiAPIKey`。`GeminiModel` 为可修改的精确模型 ID，默认 `gemini-3.5-flash-lite`；是否可用、费用和额度取决于你的账号。[模型文档](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)。
4. `GatewayURL` 默认留空。如果需要外部字幕功能，先阅读 [服务器部署说明](server/README.md)，再填写你自己的 `https://域名/v1/访问令牌`。
5. 重新进入影片，在字幕菜单中手动选择新增字幕。首次翻译有等待时间；配额不足、网络失败或模型返回不完整时，可能保留原文，需要稍后重试。

不要同时启用旧的本地版或重复匹配的 DualSubs/iRingo 播放改写规则，以免彼此覆盖。支持范围是 Loon 中的 Apple TV App 使用场景，不是 tvOS 电视盒子上的独立安装程序。

## 是否必须有 VPS

不是。有独立 WebVTT 字幕的 Gemini 翻译路径直接在 Loon 内工作。

外部字幕下载、CC 采样和对齐路径需要一个自行维护的网关，可以是 VPS，也可以是其他合适的 Linux 主机。**本仓库不提供公共网关，也不包含作者的服务器地址或 API Key。** 每个使用者需自行配置服务和凭据。

字幕关闭或不选择新增轨时，通常不会发起 Gemini 翻译；播放器若主动预加载新增字幕，仍可能触发工作，所以这不是零请求的绝对保证。配置网关后，CC-only 影片的主播放列表会先提交参考播放地址与元数据；字幕下载/翻译由字幕请求触发。

## 已知限制

- CC 校时依赖 Apple 参考流中实际可读的字幕及足够的文本匹配证据，不能保证所有内容都能抽取。
- 外部字幕可能属于不同剪辑、帧率或发行版。时长筛选、偏移/线性校准不能修复所有删减、增补或非线性错位。
- Gemini 仍可能误译，尤其是碎片化台词。代码限制跨 cue 重排，并隔离相邻 cue，不能保证模型完全遵守。
- 首次处理耗时、API 限流和播放器缓存可能导致轨道暂时不显示。切换字幕或重新进入影片有时有帮助。
- 设备本地缓存按字幕内容/语言/模型等计算键；改模型、源文件改变或缓存被清理可能需要重译。历史 DualSubs 存储前缀保留以兼容上游结构。
- 网关筛除标记为 Netflix 的发行文件，只是保守的项目策略，并不表示 Netflix 字幕天然无法对齐。

## 隐私与安全

密钥从 Loon 参数或服务器环境文件读取，不嵌入公开 JS。Loon 参数不是加密保险箱，配置分享、同步、抓包或调试日志仍可能暴露凭据。

翻译时字幕文本会发送给 Google；外部检索会向 SubDL 发送影片元数据。配置网关后，影片名、年份、时长、资产 ID 和有时包含临时签名的 Apple 参考播放 URL 会发到你填写的服务器，服务器会下载用于 CC 校时的 Apple 媒体采样。不要使用不可信的网关。

不要上传抓包、字幕缓存、API Key、环境文件、证书或部署日志。公开前请检查 [隐私说明](docs/PRIVACY.md)。API 消耗及第三方服务费用由使用者承担。仅处理你合法有权访问的内容，遵守平台条款与字幕来源的使用条件；此项目不绕过 DRM 或提供影片资源。

## 从源码构建

Node.js 22.18+；服务器需 Linux/Python 3.10+，仅使用标准库。

```sh
npm ci
npm run build
npm test
npm run test:server
npm run privacy
```

`src/` 是可编辑源码；`plugin/scripts/` 是重建后的公开脚本；`server/` 是可选网关。测试使用合成数据和模拟 API，不需要真实 Key，不下载影片，也不消耗额度。

需要持续集成时，可以把 [CI 模板](docs/ci-example.yml) 放入 `.github/workflows/check.yml`；当前提供模板，不自动部署服务器。

## 署名与许可

感谢 [DualSubs Universal](https://github.com/DualSubs/Universal) 和 VirgilClyne，以及 EXTM3U/WebVTT/XML、NanoCat 工具库与 iRingo 生态。我们保留原版权、许可及作者注释，而将插件维护署名和首页改为 JerseyRiver。

合并插件以 GPL-3.0-only 分发，上游 Apache-2.0 文件保留原许可；独立服务器使用 Apache-2.0。详见 [NOTICE](NOTICE)、[LICENSE](LICENSE) 和 [构建依赖许可](plugin/scripts/LICENSES.txt)。欢迎提交不含隐私数据的 Issue / PR。
