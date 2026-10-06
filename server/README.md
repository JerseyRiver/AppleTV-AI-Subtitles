# 字幕服务器部署教程

[返回项目首页](../README.md) · [服务器源码](app.py) · [环境配置示例](apple-subtitles.env.example)

可选组件。仅有内嵌 CC 的影片不能直接走 Loon 的 WebVTT 翻译，需要这条外部字幕路径。服务器从 SubDL 获取候选英文字幕、筛选发行版与时长，尝试用 Apple CC 文本证据做偏移或线性校时。同版本中文字幕匹配足够好时直接用中文，否则使用自己的 Gemini Key 翻译英文。

不保证所有参考流都有可读取 CC，也不保证外部字幕属于相同剪辑。字幕文本不会被校时算法重新翻译；译文继承选中英文的时间点。此服务器不处理 DRM 解密。

## 它与 Loon 插件如何配合

Loon 插件负责在 Apple TV 播放器里添加“外部中文字幕”选项，并把影片元数据和参考播放地址提交到你部署的服务器。选择该字幕后，服务器负责搜索、处理和返回字幕，Apple TV 播放器负责显示。

这部分不能脱离插件单独给 Apple TV 加字幕，也不会自动获得插件中填写的 Gemini Key。服务器使用自己的环境配置：

- `SUBDL_API_KEY`：搜索与下载外部字幕所需的 Key。
- `GEMINI_API_KEY`：没有合适的现成中文时，用于翻译英文字幕。只使用现成中文时可以不填，但没有匹配中文的影片就无法使用翻译回退。
- `ACCESS_TOKEN`：由自己生成的服务器访问令牌，不是 SubDL 或 Gemini 的 Key；Loon 的 `GatewayURL` 需要带上它。

部署顺序是：准备主机 → 下载代码 → 填写环境配置 → 启动服务 → 配置 HTTPS → 将地址填回 Loon。首次处理可能等待较久，后续播放可以读取服务器缓存。

## 环境

Linux、Python 3.10+，仅标准库（含 Linux `fcntl`）。可由 systemd 管理，监听 `127.0.0.1:8765`，HTTPS 交给 Caddy 等反向代理。外部入站只开放你配置的 HTTPS；不要直接公开 Python 端口。需要自己的 SubDL API Key；想用翻译回退还需 Gemini API Key。

## 1. 下载代码

在准备部署的 Linux 主机上下载仓库，后续命令均从仓库根目录执行：

```sh
git clone https://github.com/JerseyRiver/AppleTV-AI-Subtitles.git
cd AppleTV-AI-Subtitles
```

服务器仅依赖 Python 标准库，不需要安装 Node.js，也不需要构建 Loon 的 JS。

## 2. 安装并填写配置

下面以使用 systemd 的 Linux 主机为例。已有同名用户或目录时可跳过对应的创建步骤；已有其他服务时，请先确认目录、端口和防火墙不会冲突。

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin apple-subtitles
sudo install -d -m 755 /opt/apple-subtitles
sudo install -d -o apple-subtitles -g apple-subtitles -m 700 /var/lib/apple-subtitles
sudo install -m 644 server/app.py /opt/apple-subtitles/app.py
sudo install -m 600 server/apple-subtitles.env.example /etc/apple-subtitles.env
sudo install -m 644 server/apple-subtitles.service /etc/systemd/system/apple-subtitles.service
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
sudoedit /etc/apple-subtitles.env
```

将生成的随机字符串填入 `ACCESS_TOKEN`，填写 `SUBDL_API_KEY` 和可选 `GEMINI_API_KEY`。示例令牌必须更换；真实环境文件只保存在自己的服务器上。每个客户端的 `GatewayURL` 包含同一访问令牌，泄漏后需要更换。

## 3. 启动服务

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now apple-subtitles
curl http://127.0.0.1:8765/healthz
```

`/healthz` 返回 `ok: true` 表示服务已启动；还可检查 `subdl_configured` 和 `gemini_configured` 是否符合自己的配置。

## 4. 配置 HTTPS 并连接 Loon

为自己的域名配置 DNS，然后安装并配置你选择的反向代理。提供了 [Caddyfile.example](Caddyfile.example)：替换域名后按照 Caddy 的安装与证书验证要求配置，代理到本地 8765。若 TCP/80 或 TCP/443 已由其他服务使用，请选择兼容的证书验证方式和代理配置，并保留现有证书续期通路。

确认 `https://你的域名/healthz` 可访问且证书受客户端信任后，在 Loon 插件中填写 `GatewayURL = https://你的域名/v1/你的ACCESS_TOKEN`。默认留空不会连接任何网关。

回到 Apple TV App，重新进入影片并手动选择“外部中文字幕”。如果没有显示或首次处理失败，先检查服务日志，再核对影片是否符合 CC-only 外部字幕路径的条件。

## 缓存与请求

- `POST /v1/{token}/apple/{asset_id}/reference.json`：保存 Apple 参考流地址。
- `GET /v1/{token}/apple/{asset_id}/playlist.m3u8?...`：生成字幕 HLS 列表。
- `GET /v1/{token}/apple/{asset_id}/subtitle.vtt?...`：首次下载/匹配/翻译，成功后保存；之后读持久缓存。
- `GET /v1/{token}/apple/{asset_id}/status.json?...`：查看缓存及处理来源，不要公开结果里的敏感信息。
- `GET /healthz`：只报告版本及凭据是否配置，不返回其值。

`CACHE_DIR` 默认 `/var/lib/apple-subtitles/cache`；`MAX_CACHE_ENTRIES` 默认 200，控制最终成品数量，候选下载与 CC 参考缓存另行保存。退出客户端不会主动删除服务器缓存。多个设备连接同一网关可复用其成品；各设备 Loon 内的 Gemini 缓存不是这个服务器的缓存。

字幕 HLS/WebVTT 保留现有 Apple 时间映射策略（默认 10 秒媒体时间基准），不等于影片字幕人为延后 10 秒。算法会保守校时，证据不足时可能无法修复错位。API 配额、候选下载次数、Gemini 并发与耗时应由部署者监控。

## 安全与排错

这是私人、令牌保护的小型网关，不是面向匿名公众的字幕 SaaS。不要把网关令牌提供给所有仓库使用者：他们可以消耗你的 API 配额与计算资源。生产部署建议额外访问控制、连接/速率限制、磁盘监控和数据备份。

服务端会保存影片信息、临时 Apple 参考 URL 和字幕内容；这些文件不该提交 Git。URL 内的访问令牌也可能出现在反向代理日志中。应用尽量遮盖令牌，但不能替你清理代理日志、抓包与第三方错误。

```sh
sudo systemctl status apple-subtitles --no-pager
sudo journalctl -u apple-subtitles -n 50 --no-pager
```

分享诊断结果之前先清理令牌、Key、IP、片名、签名 URL 等隐私。测试不需要凭据：`cd server && python3 -m unittest -v`。
