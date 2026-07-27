# acmos

[English](#english) | [中文](#中文)

---

<a id="english"></a>

acmos — a multi-format AI proxy with silky-smooth switching, AC-style. Exposes OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses downstream; speaks `cc`, `am`, or `resp` upstream per provider. `combo/*` are virtual models that fall back in order.

## Features

- Ingress-to-upstream protocol conversion: Chat Completions, Messages, Responses.
- `combo/*`: same-wire candidates first, ordered fallback, target cooldown, session stickiness, multi-key failover within a provider.
- models.dev + upstream model directory sync; `GET /v1/models` exposes capability info.
- `visionSidecar`: when the target doesn't support images, a direct vision model describes the image first, then the image is replaced with text before hitting the target.
- ChatGPT Codex OAuth credential reuse and refresh: reads the official `~/.codex/auth.json`.
- Hot-reload config, redacted JSONL logs, and a runtime config snapshot.

## Install

```bash
brew tap charlzyx/acmos https://github.com/charlzyx/acmos
brew install acmos
```

Prepare config:

```bash
mkdir -p ~/.acmos
cp config.example.yml ~/.acmos/config.yml
```

Put secrets in `~/.acmos/.env`:

```dotenv
DEEPSEEK_API_KEY=...
OPENCODE_KEY_1=...
ARK_API_KEY=...
```

Reference env vars in config via `${env:NAME}`. Shell-exported vars take precedence over `.env`.

Config path resolution:

- `ACMOS_CONFIG=/absolute/path/config.yml`: explicit config file.
- `ACMOS_HOME=/absolute/path`: data directory; defaults to `~/.acmos`.

Start the service:

```bash
brew services start acmos
```

| Command | Action |
|---|---|
| `brew services start acmos` | Start and enable at login |
| `brew services stop acmos` | Stop |
| `brew services restart acmos` | Restart |
| `brew services info acmos` | Status |
| `brew upgrade acmos` | Upgrade |

Listens on `http://127.0.0.1:20129` by default. Health check:

```bash
curl http://127.0.0.1:20129/health
```

If `apiKeys` is set, all `/v1/*` requests require a Bearer token:

```bash
curl http://127.0.0.1:20129/v1/models \
  -H 'Authorization: Bearer your-local-key'
```

## Quick Start (Free Tier)

No upstream API key? Try OpenCode Zen's free tier ([register for a free key](https://opencode.ai)). For higher rate limits, use [OpenCode Go](https://opencode.ai/go?ref=WZ29Q4GHM0) (referral link).

`~/.acmos/config.yml`:

```yaml
providers:
  opencode:
    wire: cc
    baseUrl: https://opencode.ai/zen/v1
    apiKey: "${env:OPENCODE_KEY}"
    defaults:
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
    models:
      - id: deepseek-v4-flash-free
      - id: mimo-v2.5-free
      - id: ling-3.0-flash-free
      - id: nemotron-3-ultra-free
      - id: north-mini-code-free
      - id: laguna-s-2.1-free

combo:
  free:
    description: Free tier, ordered fallback
    members:
      - { provider: opencode, model: deepseek-v4-flash-free }
      - { provider: opencode, model: mimo-v2.5-free }
      - { provider: opencode, model: ling-3.0-flash-free }
      - { provider: opencode, model: nemotron-3-ultra-free }
      - { provider: opencode, model: north-mini-code-free }
      - { provider: opencode, model: laguna-s-2.1-free }
```

`~/.acmos/.env`:

```dotenv
OPENCODE_KEY=sk-...   # get a free key at opencode.ai
```

```bash
brew services restart acmos
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"combo/free","messages":[{"role":"user","content":"be concise, say OK"}]}'
```

## Downstream API

| API | Path |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| Anthropic Messages | `POST /v1/messages` |
| OpenAI Responses | `POST /v1/responses` |
| Model list | `GET /v1/models` |
| Health check | `GET /health` |

Prefer combo: `combo/max`, `combo/coder`, `combo/fast`, `combo/free`. Direct models use `provider/model-id`, e.g. `codex/gpt-5.6-terra`. Providers can have `aliases`; models don't use aliases.

Chat Completions example:

```bash
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-local-key' \
  -d '{
    "model": "combo/coder",
    "messages": [{"role": "user", "content": "reply OK only"}]
  }'
```

### Wire Paths

`cc` = OpenAI Chat Completions, `am` = Anthropic Messages, `resp` = OpenAI Responses. Combo prefers same-wire members; only falls back to conversion when no same-wire candidate is available or all fail.

```text
Downstream Chat Completions (/v1/chat/completions, cc)
├── upstream cc
│   └── CC request ──> /chat/completions ──> CC response
├── upstream am
│   └── CC ──convert──> AM request ──> /messages ──> AM ──convert──> CC response
└── upstream resp
    └── CC ──convert──> Responses request ──> /responses ──> Responses ──convert──> CC response

Downstream Anthropic Messages (/v1/messages, am)
├── upstream am
│   └── AM passthrough (only replace model; image sidecar rewrites images then rebuilds AM request)
├── upstream cc
│   └── AM ──convert──> CC request ──> /chat/completions ──> CC ──convert──> AM response
└── upstream resp
    └── AM ──convert──> CC ──convert──> Responses request ──> /responses
        └── Responses ──convert──> CC ──convert──> AM response

Downstream OpenAI Responses (/v1/responses, resp)
└── Responses ──normalized to CC──> reuse the CC paths above by target wire
    └── final CC response/stream ──convert──> Responses response/stream
```

```text
combo/fast selection example
├── cc ingress
│   └── try all wire=cc Flash members first
│       └── only when cc members fail, try wire=am DeepSeek Flash
├── am ingress
│   └── try wire=am DeepSeek Flash first
│       └── only when AM member fails, try cc members
└── resp ingress
    └── no resp Flash member currently, fall back to other wires in config order
```

```text
Image sidecar (orthogonal to wire selection)
├── target supports vision
│   └── original image sent directly to target
└── target does not support vision
    ├── visionSidecar model describes the image
    ├── image_url ──> [image: description]
    ├── rewritten request sent to target
    └── if fallback occurs during this request
        └── reuse the same description, don't call the vision model again
```

## Configuration

Full example in [`config.example.yml`](./config.example.yml). Common top-level fields:

```yaml
host: 127.0.0.1
port: 20129
apiKeys: ["${env:ACMOS_API_KEY}"]
proxy: http://127.0.0.1:7890

log:
  level: info             # debug | info | warn | error
  file: true
  captureBody: false      # logs request/response bodies when enabled; short-term debugging only
  retentionDays: 7

visionSidecar:
  enabled: true
  model: codex/gpt-5.6-luna
  maxTokens: 1024
```

### Provider

```yaml
providers:
  example:
    wire: cc              # cc | am | resp
    baseUrl: https://example.com/v1
    aliases: [example-ai]
    apiKey: "${env:EXAMPLE_API_KEY}"
    timeoutMs: 600000
    firstByteTimeoutMs: 60000
    models:
      - id: example-model
```

Auth methods:

- `apiKey`: Bearer token shorthand; a string or array of keys.
- `auth.type: bearer`: standard `Authorization: Bearer ...`.
- `auth.type: header`: custom header, e.g. Anthropic's `x-api-key`.
- `auth.type: chatgpt-oauth`: reuse official Codex login. Run `codex login` first, then set `credentialsPath`, usually `~/.codex/auth.json`.
- `auth.type: none`: no upstream auth.

For multiple keys, use `auth.keyStrategy`: `round-robin`, `sticky`, or `failover`. `failover` tries the next key when the current one returns a retryable error.

### Combo

Combo groups by ingress wire first: `cc`, `am`, `resp` requests prefer same-wire members to avoid unnecessary conversion; within a group, config order and session stickiness are preserved. Other-wire members are only tried when no same-wire candidate exists or all fail. Upstream switching is only allowed before the first byte is sent.

To expose the same service via multiple wires, put them all in one combo:

```yaml
combo:
  coder:
    sticky: true
    members:
      - { provider: codex, model: gpt-5.6-terra }       # resp
      - { provider: opencode, model: glm-5.2 }          # cc
      - { provider: deepseek-am, model: deepseek-v4-flash } # am
```

### Vision Sidecar

`visionSidecar` processes the internal normalized `image_url` content block; both Chat Completions and Anthropic image inputs go through this:

1. Target model declares `vision: true`: original image sent directly.
2. Target doesn't support vision: sidecar calls a direct vision model to describe the image.
3. acmos replaces the image with `[image: ...]` text, then sends to the target.
4. Sidecar failure: original request is preserved; the error is logged.

The sidecar model must be a configured direct vision model, not a combo, to avoid recursive fallback.

## CLI Integration

For any OpenAI-compatible client, point the base URL to `http://127.0.0.1:20129/v1` and use a local key from `apiKeys`.

Pi / OMP provider form:

```yaml
providers:
  combo:
    baseUrl: http://127.0.0.1:20129/v1
    apiKey: your-local-key
    api: openai-completions
```

Claude Code uses Anthropic Messages; user-level `~/.claude/settings.json`:

```json
{
  "model": "combo/coder",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:20129",
    "ANTHROPIC_API_KEY": "your-local-key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "combo/max",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "combo/coder",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "combo/fast"
  }
}
```

## Development

Prerequisite: Bun >= 1.2.

```bash
bun install
bun run dev       # start with file-watch auto-restart
bun run typecheck
bun run lint
bun run test
bun run format
```

Build a standalone binary (for release):

```bash
bun build --compile src/cli.ts --outfile dist/acmos
```

Config changes hot-reload; parse or cross-validation failures keep the old config. A redacted snapshot is written on startup or successful reload:

```text
~/.acmos/config.snapshot.yaml
```

## Logging & Troubleshooting

Logs go to both stderr and JSONL files:

```text
~/.acmos/logs/acmos-YYYY-MM-DD.jsonl
```

Each request log carries a `reqId`. Use it to trace "request received" → "upstream response headers arrived" → "request completed" or failure:

```bash
# watch service stderr live
bun run start

# trace a single request's full path
jq 'select(.reqId == "abcd1234")' ~/.acmos/logs/acmos-$(date +%F).jsonl

# find fallback, cooldown, and auth issues
jq 'select(.level == "warn" or .level == "error")' ~/.acmos/logs/acmos-$(date +%F).jsonl
```

Common symptoms:

| Symptom | Check first |
| --- | --- |
| `401` / `auth` | ingress `apiKeys`, provider key, Codex `auth.json` validity |
| `429` / `quota` | provider rate limit; logs for cooldown, fallback targets, key failover |
| `504` / `timeout` | `firstByteTimeoutMs`, `timeoutMs`, proxy connectivity |
| `400` / `badRequest` | upstream wire and `compat` settings; temporarily enable body capture |
| Image request failure | `visionSidecar` enabled, sidecar model is a vision model, sidecar request logs |
| Model not found | `GET /v1/models`, provider `models`, combo member references, upstream directory sync |

Body-level debugging: set `log.level` to `debug` and temporarily set `log.captureBody: true`; turn it off immediately after reproducing. Recorded bodies may contain user content; logs recursively redact common token/header fields, but treat them as sensitive.

## Security Boundary

- Never commit `~/.acmos/.env`, `~/.acmos/config.yml`, OAuth credentials, or logs.
- `config.snapshot.yaml` is redacted and for audit only.
- Bind to `127.0.0.1` recommended; to listen externally, configure strong random `apiKeys` and use a reverse proxy for TLS and access control.

## Support

If acmos helps you, consider [supporting me on 爱发电](https://afdian.com/a/charlzyx) or follow me on [Twitter/X @chaogpt](https://twitter.com/chaogpt).

---

<a id="中文"></a>

# acmos（中文）

acmos — 交流电般丝滑切换的多协议 AI 代理。对下游提供 OpenAI Chat Completions、Anthropic Messages 和 OpenAI Responses；对上游可按 provider 使用 `cc`、`am` 或 `resp` 协议。`combo/*` 是按顺序 fallback 的虚拟模型。

## 能力

- 入站与上游协议转换：Chat Completions、Messages、Responses。
- `combo/*` 同协议候选优先、顺序 fallback、目标冷却、会话粘性、同 provider 多 key failover。
- models.dev 与上游模型目录同步；`GET /v1/models` 公开能力信息。
- `visionSidecar`：目标不支持图片时，先使用直连视觉模型生成描述，再把图片替换为文本交给原目标。
- ChatGPT Codex OAuth 凭据复用与刷新：读取官方 `~/.codex/auth.json`。
- 配置热重载、脱敏 JSONL 日志和运行时配置快照。

## 安装

```bash
brew tap charlzyx/acmos https://github.com/charlzyx/acmos
brew install acmos
```

准备配置：

```bash
mkdir -p ~/.acmos
cp config.example.yml ~/.acmos/config.yml
```

把密钥写入 `~/.acmos/.env`：

```dotenv
DEEPSEEK_API_KEY=...
OPENCODE_KEY_1=...
ARK_API_KEY=...
```

配置中通过 `${env:NAME}` 引用环境变量。shell 已导出的同名变量优先于 `.env`。

配置路径优先级：

- `ACMOS_CONFIG=/absolute/path/config.yml`：指定配置文件。
- `ACMOS_HOME=/absolute/path`：指定数据目录；默认 `~/.acmos`。

启动服务：

```bash
brew services start acmos
```

| 命令 | 作用 |
|---|---|
| `brew services start acmos` | 启动并设为开机自启 |
| `brew services stop acmos` | 停止 |
| `brew services restart acmos` | 重启 |
| `brew services info acmos` | 查看状态 |
| `brew upgrade acmos` | 升级 |

默认监听 `http://127.0.0.1:20129`。健康检查：

```bash
curl http://127.0.0.1:20129/health
```

若设置了 `apiKeys`，所有 `/v1/*` 请求必须带 Bearer token：

```bash
curl http://127.0.0.1:20129/v1/models \
  -H 'Authorization: Bearer your-local-key'
```

## 体验配置

没有上游 API key？用 OpenCode Zen 免费版即可开箱体验（[免费注册拿 key](https://opencode.ai)）。需要更大的速率上限可以用 [OpenCode Go](https://opencode.ai/go?ref=WZ29Q4GHM0)（我的邀请链接）。

`~/.acmos/config.yml`：

```yaml
providers:
  opencode:
    wire: cc
    baseUrl: https://opencode.ai/zen/v1
    apiKey: "${env:OPENCODE_KEY}"
    defaults:
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
    models:
      - id: deepseek-v4-flash-free
      - id: mimo-v2.5-free
      - id: ling-3.0-flash-free
      - id: nemotron-3-ultra-free
      - id: north-mini-code-free
      - id: laguna-s-2.1-free

combo:
  free:
    description: 免费档，按顺序 fallback
    members:
      - { provider: opencode, model: deepseek-v4-flash-free }
      - { provider: opencode, model: mimo-v2.5-free }
      - { provider: opencode, model: ling-3.0-flash-free }
      - { provider: opencode, model: nemotron-3-ultra-free }
      - { provider: opencode, model: north-mini-code-free }
      - { provider: opencode, model: laguna-s-2.1-free }
```

`~/.acmos/.env`：

```dotenv
OPENCODE_KEY=sk-...   # 去 opencode.ai 免费拿
```

```bash
brew services restart acmos
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"combo/free","messages":[{"role":"user","content":"be concise, say OK"}]}'
```

## 下游 API

| API | 路径 |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| Anthropic Messages | `POST /v1/messages` |
| OpenAI Responses | `POST /v1/responses` |
| 模型列表 | `GET /v1/models` |
| 健康检查 | `GET /health` |

优先使用 combo：`combo/max`、`combo/coder`、`combo/fast`、`combo/free`。直连模型使用 `provider/model-id`，例如 `codex/gpt-5.6-terra`。provider 可以配置 `aliases`；模型不使用别名。

Chat Completions 示例：

```bash
curl http://127.0.0.1:20129/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your-local-key' \
  -d '{
    "model": "combo/coder",
    "messages": [{"role": "user", "content": "只回复 OK"}]
  }'
```

### Wire 路径

`cc` = OpenAI Chat Completions，`am` = Anthropic Messages，`resp` = OpenAI Responses。combo 优先选择与入站相同的 wire；没有同格式候选或同格式候选失败时，才走转换 fallback。

```text
下游 Chat Completions (/v1/chat/completions, cc)
├── 上游 cc
│   └── CC 请求 ──> /chat/completions ──> CC 响应
├── 上游 am
│   └── CC ──转换──> AM 请求 ──> /messages ──> AM ──转换──> CC 响应
└── 上游 resp
    └── CC ──转换──> Responses 请求 ──> /responses ──> Responses ──转换──> CC 响应

下游 Anthropic Messages (/v1/messages, am)
├── 上游 am
│   └── AM 原样透传（仅替换 model；图片 sidecar 触发时会转写图片后重建 AM 请求）
├── 上游 cc
│   └── AM ──转换──> CC 请求 ──> /chat/completions ──> CC ──转换──> AM 响应
└── 上游 resp
    └── AM ──转换──> CC ──转换──> Responses 请求 ──> /responses
        └── Responses ──转换──> CC ──转换──> AM 响应

下游 OpenAI Responses (/v1/responses, resp)
└── Responses ──归一为 CC──> 按目标 wire 复用上述 CC 路径
    └── 最终 CC 响应/流 ──转换──> Responses 响应/流
```

```text
combo/fast 的选择示例
├── cc 入站
│   └── 先试所有 wire=cc 的 Flash 成员
│       └── cc 成员不可用时，才试 wire=am 的 DeepSeek Flash
├── am 入站
│   └── 先试 wire=am 的 DeepSeek Flash
│       └── AM 成员不可用时，才试 cc 成员
└── resp 入站
    └── 当前无 resp Flash 成员，按配置顺序回退到其他 wire
```

```text
图片 sidecar（与 wire 选择正交）
├── 选定目标支持 vision
│   └── 原始图片直接发送给该目标
└── 选定目标不支持 vision
    ├── visionSidecar 视觉模型描述图片
    ├── image_url ──> [image: 图片描述]
    ├── 转写后的请求发送给选定目标
    └── 当前请求若发生 fallback
        └── 复用同一图片描述，不重复调用视觉模型
```

## 配置

完整示例见 [`config.example.yml`](./config.example.yml)。常用顶层字段：

```yaml
host: 127.0.0.1
port: 20129
apiKeys: ["${env:ACMOS_API_KEY}"]
proxy: http://127.0.0.1:7890

log:
  level: info             # debug | info | warn | error
  file: true
  captureBody: false      # 开启会记录已埋点的入站/上游请求体，仅限短时排障
  retentionDays: 7

visionSidecar:
  enabled: true
  model: codex/gpt-5.6-luna
  maxTokens: 1024
```

### Provider

```yaml
providers:
  example:
    wire: cc              # cc | am | resp
    baseUrl: https://example.com/v1
    aliases: [example-ai]
    apiKey: "${env:EXAMPLE_API_KEY}"
    timeoutMs: 600000
    firstByteTimeoutMs: 60000
    models:
      - id: example-model
```

鉴权方式：

- `apiKey`：Bearer token 简写；字符串或 key 数组。
- `auth.type: bearer`：标准 `Authorization: Bearer ...`。
- `auth.type: header`：自定义 header，例如 Anthropic 的 `x-api-key`。
- `auth.type: chatgpt-oauth`：复用官方 Codex 登录态。先执行 `codex login`，再配置 `credentialsPath`，通常为 `~/.codex/auth.json`。
- `auth.type: none`：不附加上游鉴权。

多 key 时使用 `auth.keyStrategy`：`round-robin`、`sticky` 或 `failover`。`failover` 会在当前 provider 返回可重试错误时尝试下一把 key。

### Combo

combo 先按入站 wire 分组：`cc`、`am`、`resp` 请求优先尝试同协议成员，避免无必要的格式转换；同组内保持配置声明顺序和会话粘性。没有同协议候选或它们全部失败时，才尝试其他 wire 的成员。只有首字节到达前可切换上游。

因此，为同一服务配置多种 wire 时，应把它们都写入同一个 combo：

```yaml
combo:
  coder:
    sticky: true
    members:
      - { provider: codex, model: gpt-5.6-terra }       # resp
      - { provider: opencode, model: glm-5.2 }          # cc
      - { provider: deepseek-am, model: deepseek-v4-flash } # am
```

### 视觉 sidecar

`visionSidecar` 处理内部归一后的 `image_url` 内容块；Chat Completions 与 Anthropic 图片输入都会经过这一步：

1. 目标模型已声明 `vision: true`：原图直接发送。
2. 目标不支持视觉：sidecar 直连视觉模型生成描述。
3. acmos 将图片替换为 `[image: ...]` 文本，再请求原目标。
4. sidecar 失败：保留原始请求；日志会记录失败原因。

sidecar 模型必须是已配置的直连视觉模型，不能是 combo，避免递归 fallback。

## CLI 集成

使用任意 OpenAI-compatible 客户端时，base URL 指向 `http://127.0.0.1:20129/v1`，API key 使用 `apiKeys` 中配置的本地 key。

Pi / OMP 的 provider 形态：

```yaml
providers:
  combo:
    baseUrl: http://127.0.0.1:20129/v1
    apiKey: your-local-key
    api: openai-completions
```

Claude Code 使用 Anthropic Messages，用户级 `~/.claude/settings.json` 可配置：

```json
{
  "model": "combo/coder",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:20129",
    "ANTHROPIC_API_KEY": "your-local-key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "combo/max",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "combo/coder",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "combo/fast"
  }
}
```

## 开发

前置条件：Bun >= 1.2。

```bash
bun install
bun run dev       # 启动，文件变更自动重启
bun run typecheck
bun run lint
bun run test
bun run format
```

构建独立二进制（发布用）：

```bash
bun build --compile src/cli.ts --outfile dist/acmos
```

配置变更会热重载；解析或交叉校验失败时继续保留旧配置。启动或热重载成功后会生成脱敏快照：

```text
~/.acmos/config.snapshot.yaml
```

## 日志与排障

日志同时写 stderr 和 JSONL 文件：

```text
~/.acmos/logs/acmos-YYYY-MM-DD.jsonl
```

每个请求日志会带 `reqId`。用它串联"收到请求""上游响应头已到达""请求完成"或失败记录：

```bash
# 终端实时观察服务 stderr
bun run start

# 查询某次请求的完整链路
jq 'select(.reqId == "abcd1234")' ~/.acmos/logs/acmos-$(date +%F).jsonl

# 查询 fallback、冷却和鉴权问题
jq 'select(.level == "warn" or .level == "error")' ~/.acmos/logs/acmos-$(date +%F).jsonl
```

常见现象：

| 现象 | 优先检查 |
| --- | --- |
| `401` / `auth` | 入站 `apiKeys`、provider key、Codex `auth.json` 是否可用 |
| `429` / `quota` | provider 限流；日志中的 cooldown、fallback 目标与 key failover |
| `504` / `timeout` | `firstByteTimeoutMs`、`timeoutMs`、proxy 连通性 |
| `400` / `badRequest` | 上游 wire 与兼容配置 `compat`；必要时短时开启 body capture |
| 图片请求失败 | `visionSidecar` 是否启用、sidecar 模型是否视觉模型、sidecar 请求日志 |
| 模型不存在 | `GET /v1/models`、provider `models`、combo 成员引用和上游目录同步 |

请求体排障：将 `log.level` 调为 `debug` 并临时设置 `log.captureBody: true`，复现一次后立即关闭。已记录的请求体可能包含用户内容；日志会递归脱敏常见 token/header 字段，但仍应按敏感数据处理。

## 安全边界

- 不提交 `~/.acmos/.env`、`~/.acmos/config.yml`、OAuth 凭据或日志。
- `config.snapshot.yaml` 已脱敏，仅用于审计。
- 推荐绑定 `127.0.0.1`；若要监听外网，必须配置强随机 `apiKeys` 并由反向代理提供 TLS 与访问控制。

## 支持

如果 acmos 对你有帮助，欢迎[在爱发电请我喝杯咖啡](https://afdian.com/a/charlzyx)，或关注我的 [Twitter/X @chaogpt](https://twitter.com/chaogpt)。

---

*Inspired by [9router](https://github.com/decolua/9router) and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).*
