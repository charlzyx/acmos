# acmos

一个单纯的多格式 AI 代理。对下游同时说 **OpenAI Chat Completions** / **Anthropic Messages** / **OpenAI Responses** 三种协议，对上游裸 `fetch` 直连。核心能力是 `combo/*` 虚拟 provider：一个模型名背后是一串有序上游，按顺序 fallback + 会话粘性。

无 Web UI，只有结构化日志。

---

## 1. 设计决策

| 议题 | 决定 |
|---|---|
| 产物 | 可运行 HTTP 服务，单进程 |
| 运行时 | Bun + TypeScript + Hono |
| 上游客户端 | 裸 `fetch` + 自写 SSE 解析，**不引入 AI SDK 到数据通路** |
| codex 鉴权 | 复用 `~/.codex/auth.json` 的 token，acmos 只负责 refresh；直连 chatgpt.com backend-api，走 HTTP 代理出网 |
| combo 语义 | 顺序 fallback + 会话粘性 |
| 流中途切换 | 只在首字节吹出前切；写中断续传列入后续 |
| 入站端点 | `/v1/chat/completions`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses`、`GET /v1/models` |
| 与 9router | 并存，acmos 占新端口逐步迁移 |
| 配置 | 全部写文件；由 **c12** 加载（YAML/TS/JSON、`extends` 分层、dotenv、热重载），**zod** 只管校验。DB 只存运行时状态 |
| thinking | 内部六档 level（`minimal/low/medium/high/xhigh/max`），每上游配 map |
| 识图 | 自动旁路：含图且目标不支持 vision → 先调 vision 模型转文字描述再内联 |
| 可观测性 | 只做 log：结构化 JSONL 落 `~/.acmos/logs/`，可选原始 body 抓取用于排查转换 bug |
| 部署默认值 | 端口 `20129`，配置 `~/.acmos/config.yml`，DB `~/.acmos/state.db`，代理 `http://127.0.0.1:7890` |

### 关键架构决策：中立超集 IR

不像 9router 那样拿 OpenAI Chat Completions 当中枢格式（`source → OpenAI → target` 两跳会丢字段）。
acmos 定义**中立超集 IR**，每个 thinking / reasoning block 携带 provenance（`origin` + `raw`）：

- 目标格式 === 来源格式 → **逐字节回放原始 JSON**
- 目标格式 ≠ 来源格式 → 按规则降级

这样才能保住 Anthropic `thinking.signature` 和 Responses `reasoning.encrypted_content`——
这两个字段任何一个丢了，多轮对话第二轮就会断链。

N×N 转换器因此收敛成 **3 个解码器 + 3 个编码器**。

### 快路径

ingress 格式 === 上游 wire 格式时走 near-passthrough：只改 model 名、auth header、参数增删，
SSE 流 tee 一份嗅探 usage，**不做反序列化重编码**。

---

## 2. 上游清单

| id | wire 协议 | baseUrl | 鉴权 | 备注 |
|---|---|---|---|---|
| `codex` | responses | `https://chatgpt.com/backend-api/codex` | ChatGPT OAuth（读 `~/.codex/auth.json`） | 需 HTTP 代理出网；header 需 `chatgpt-account-id` / `originator` / `session_id`；`store:false` |
| `opencode` | chat-completions | `https://opencode.ai/zen/v1` | Bearer | models.dev 标注 `@ai-sdk/openai-compatible` |
| `ark-am` | anthropic-messages | `https://ark.cn-beijing.volces.com/api/coding` | Bearer | 火山 Ark coding plan |
| `ark-oai` | chat-completions + responses | `https://ark.cn-beijing.volces.com/api/coding/v3` | Bearer | 同账号双协议 |
| `deepseek` | chat-completions | `https://api.deepseek.com` | Bearer | quirks 见 `~/.omp/agent/models.yml` 的 `deepseek.compat` |

密钥一律走 `~/.acmos/.env` + 配置里 `${env:XXX}` 引用，不进仓库。

**Ark 是保真度靶场**：同一个 `glm-5.2` 同时暴露 anthropic / chat-completions / responses 三种协议，
用同一 prompt 分三条路走一遍，输出对不上就说明转换层在丢字段。

### Combo 初始定义

- `combo/max` = `codex/gpt-5.6-sol` → `opencode/glm-5.2`
- `combo/fast` = `codex/gpt-5.6-luna` → `opencode/deepseek-v4-flash`
- 其余（`coder` / `codecn` / `think` / `free` / `k3`）按现有 9router 配置迁移

---

## 3. 目录结构

```
src/
  server.ts            Hono 入口 + 路由
  config/              YAML 加载 + zod 校验 + ${env:X} 插值
  ingress/             cc | am | resp | countTokens | models
  ir/                  types.ts —— IR 定义（整个项目的地基）
  translate/
    toIR/              cc | am | resp        请求解析
    fromIR/            cc | am | resp        请求序列化
    stream/decode/     cc | am | resp        上游 SSE → IR 事件流
    stream/encode/     cc | am | resp        IR 事件流 → 下游 SSE
    concerns/          toolCall | thinking | finishReason | usage | image
  upstream/
    client.ts          裸 fetch + 代理 + 重试 + 取消传播
    sse.ts             SSE 解析器
    auth/              chatgptOAuth | apiKey
  route/
    combo.ts           成员解析 + 顺序 fallback
    sticky.ts          会话粘性
    cooldown.ts        限流/额度冷却
  catalog/             models.dev 同步 + 能力查询
  vision/              识图旁路 + 结果缓存
  log/                 logger（JSONL）+ trace（原始 body 抓取）
  state/               bun:sqlite schema + repo
tests/
  golden/              录制的 SSE fixture + 快照断言
```

---

## 4. 进度

### P0 骨架

- [x] 1. Bun + Hono 项目初始化（`package.json` / `tsconfig.json` / `biome.json` / `PLAN.md`）
- [x] 2. `src/ir/types.ts` —— IR 定义
- [x] 3. `src/config/` —— c12 加载（YAML/TS/JSON、`extends` 分层、dotenv、watch）+ zod 校验 + `${env:X}` 插值
- [ ] 4. `src/log/` —— 结构化 JSONL logger + 原始 body trace
- [ ] 5. `src/state/` —— bun:sqlite schema 与 repo
- [ ] 6. `src/catalog/` —— models.dev 同步、TTL、离线兜底
- [ ] 7. `src/upstream/` —— SSE 解析器、HTTP 代理、超时、AbortSignal 透传、key 轮转
- [ ] 8. `src/server.ts` + `GET /v1/models`
- [ ] 9. CC→CC 直通打通（`deepseek` + `opencode` 端到端可用）

### P1 Codex 上游（★ 最高优先）

- [ ] 10. `src/upstream/auth/chatgptOAuth.ts` —— 读 `~/.codex/auth.json`，自负责 refresh
- [ ] 11. Responses 请求构造：`input[]` / `instructions` / `developer` role / 字段白名单 / `store:false` / 剥离 server item id
- [ ] 12. Responses SSE 解码器
- [ ] 13. CC 入 → Responses 出（omp / pi → codex）
- [ ] 14. thinking 六档归一 + reasoning item 原样回放

### P2 下游 Anthropic

- [ ] 15. `/v1/messages` 入站 + Anthropic SSE 编码器
- [ ] 16. AM 入 → Responses 出（claude code → codex，★ 优先路径）
- [ ] 17. AM 入 → CC 出
- [ ] 18. `/v1/messages/count_tokens` 粗略估算

### P3 combo 路由

- [ ] 19. 顺序 fallback（仅首字节前）
- [ ] 20. 会话粘性
- [ ] 21. 冷却退避 + 额度窗口感知
- [ ] 22. usage 落库 + 成本计算

### P4 Responses 入站

- [ ] 23. Responses 入站解析 + 编码器
- [ ] 24. RESP→RESP 快路径
- [ ] 25. RESP→CC 转换

### P5 识图旁路

- [ ] 26. 能力检测 + vision 模型调用
- [ ] 27. 按图片 hash 缓存并内联替换

### P6 收尾

- [ ] 28. golden 测试（fixture 录制 + 快照 + roundtrip 断言）
- [ ] 29. 四客户端联调（omp / pi / claude code / codex cli）
- [ ] 30. 迁移文档

---

## 5. 验证标准

1. `bun test` golden 快照：三格式两两互转的请求 + 流式响应
2. **roundtrip 逐字节等价**：`AM→IR→AM`、`RESP→IR→RESP`，`signature` / `encrypted_content` 一 bit 不能丢
3. **Ark 三协议交叉验证**：同一 `glm-5.2` + 同一 prompt（含 tool call + thinking），分别经 `ark-am` / `ark-oai(cc)` / `ark-oai(responses)`，比对最终输出一致
4. omp / pi 把 combo baseUrl 改到 `:20129`，跑一轮带 tool call 的任务
5. Claude Code 设 `ANTHROPIC_BASE_URL` 到 `:20129`，验证 `count_tokens` 不报错、thinking 正常显示
6. Codex CLI `base_url` 指到 `:20129` + `wire_api=responses`，验证多轮 reasoning 不断链
7. 故障注入：combo 首成员 apiKey 改错，验证自动 fallback 且客户端无感
8. 粘性验证：同会话连续多轮，`sticky_session` 命中同一 target
9. key 轮转：opencode 多把 key，人为触发 429，验证自动切换与冷却

---

## 6. 明确排除

- Web Dashboard / 管理 UI
- OAuth 多账户轮转（保留轻量 API key 数组轮转）
- RTK / prompt 压缩
- embeddings / tts / stt / 图像生成端点
- Gemini / Kiro / Cursor 等其他 wire 协议
- 写中断后的流式续传

---

## 7. 参考

`9router/` 是只读参考实现（MIT）。acmos 不复制其代码，只借鉴逻辑：

- `9router/open-sse/translator/index.js` —— 流式状态机字段清单
- `9router/open-sse/translator/response/claude-to-openai.js`、`openai-to-claude.js`
- `9router/open-sse/translator/{request,response}/openai-responses.js`
- `9router/open-sse/executors/codex.js` —— Codex 请求规范化步骤
- `9router/tests/translator/golden-*.test.js` —— 测试组织方式
- `~/.omp/agent/models.yml` —— 配置 schema 蓝本
