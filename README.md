# 花砖物语 Azul · 在线对战

Node.js + Express + SQLite（Node 内置 `node:sqlite`）+ React（免构建）+ Socket.io 实现的 Azul 桌游在线对战网站，支持 2-4 人、真人与 AI 混战。

## 环境要求

- **Node.js ≥ 22.5**（项目使用内置 `node:sqlite` 模块，无需编译原生扩展）

## 安装与启动

```bash
cd azul-online
npm install
npm start          # 默认 http://localhost:3000
```

可选环境变量：`PORT`（端口）、`JWT_SECRET`（生产环境请务必设置）。

数据库文件自动生成在 `data/azul.db`，表结构：`users` / `games` / `game_players` / `game_state`。

## 使用说明

1. **注册 / 登录**：打开网站，填写邮箱 + 昵称 + 密码注册（密码 bcrypt 加密存储），登录后凭 JWT 进入大厅。
2. **创建房间**：大厅右侧填写房间名、选择最大人数（2/3/4），点击"创建房间"。
3. **加入房间**：大厅左侧房间列表点击"加入"（人满或游戏中不可加入）。
4. **添加 AI**：房主在房间内输入 AI 昵称（可留空随机起名）、选择难度（简单/中等/困难）后点击"+ 添加 AI"，可随时移除；人数补足 2-4 人即可。
   - **简单**：只看眼前能放几块，带随机性，常犯小错；
   - **中等**：启发式策略（填满行 > 上墙得分 > 避免扣分 > 抢先手）；
   - **困难**：中等策略 + 一层前瞻，会刻意压制下家的最佳回应（实测对简单胜率 97%、对中等 63%）；
   - **大模型 API**：接入任意 OpenAI 兼容接口（DeepSeek / Kimi / 通义 / OpenAI 等），填 API 地址 + 模型名 + API Key 即可让真·大模型上桌。模型还会在出招时说一句台词（聊天气泡提示）。
     - API Key 只保存在服务端内存：不写入数据库、不下发给任何前端；
     - 模型调用失败 / 超时（30s）/ 给出非法操作时，自动回退为"困难"启发式 AI，游戏永不卡死；
     - DeepSeek 默认配置开箱即用：地址 `https://api.deepseek.com/v1`，模型 `deepseek-chat`。
5. **开始游戏**：房主点击"开始游戏"，所有玩家进入游戏界面。
6. **游戏操作**：
   - 轮到你时，点击某个**工厂盘**或**桌面中央**里的一块瓷砖（即选定该处该颜色的全部瓷砖）；
   - 再点击你玩家板上高亮的**图案行**放置（多余的自动落入地板行），或点击**地板行**全部弃置；
   - 第一个从中央拿瓷砖的玩家获得 1 号标记（下轮先手，本轮计入地板扣分）。
7. **回合结算**：工厂与中央清空后自动拼贴墙壁、计分、扣地板分；任一玩家完成完整横排后进行终局计分（横排 +2 / 纵列 +7 / 同色集齐 +10）并弹出排名。
8. **动画与音效**：拿取/放置瓷砖有弧线飞行动画与陶瓷音效（WebAudio 实时合成，无音频文件）；计分有提示音，右上角 🔊 按钮可静音。

## 和朋友联机对战

服务器监听 `0.0.0.0`，启动时控制台会打印**局域网邀请地址**（如 `http://192.168.x.x:3000`）：

- **同一 WiFi / 局域网**：把该地址发给朋友，对方浏览器打开、注册账号、在大厅加入你的房间即可。首次可能需要在 Windows 防火墙弹窗中允许 Node.js 访问专用网络（或手动放行 3000 端口入站）。
- **不在同一网络**：任选其一——
  1. 内网穿透：`cloudflared tunnel --url http://localhost:3000`（免费）或 ngrok，把生成的公网链接发给朋友；
  2. 部署到 Render（见下节）或其他云服务器。

## 部署到 Render（免费公网访问）

项目已带 `render.yaml` 部署蓝图。步骤：

1. 推送到 GitHub（首次需登录）：
   ```powershell
   gh auth login                 # 浏览器确认登录
   cd azul-online
   gh repo create azul-online --private --source . --push
   ```
2. 打开 [dashboard.render.com](https://dashboard.render.com)（用 GitHub 账号注册/登录）→ **New → Blueprint** → 选择 `azul-online` 仓库 → **Apply**。
3. 等待构建完成（约 1-2 分钟），获得 `https://azul-online-xxxx.onrender.com` 公网地址，发给朋友即可联机。

之后每次 `git push`，Render 会自动重新部署。

**免费套餐注意事项**：
- 15 分钟无访问会休眠，下次打开需等约 30-60 秒冷启动；
- 磁盘是临时的：**每次部署/重启后 SQLite 数据（账号、战绩）会清空**，大家重新注册即可。要长期保留数据，升级付费套餐并按 `render.yaml` 内注释挂载持久磁盘 + 设置 `DATA_DIR=/var/data`；
- `JWT_SECRET` 由蓝图自动生成，无需手动配置。

## 可靠性

- **断线重连**：刷新页面 / 短暂掉线后重新连接会自动回到原房间与对局；
- **服务器重启恢复**：进行中的对局每步都落库（`game_state` 表），服务器重启后自动恢复，玩家重连即可继续（大模型 AI 的 Key 只在内存，恢复后降级为困难启发式 AI）。

## 防作弊设计

游戏状态完全由服务端管理；前端只发送操作意图 `{ source, color, targetLine }`，服务端校验（是否当前回合、来源/颜色/目标行合法性）后才执行并全量广播 `game_state`。袋中瓷砖顺序不下发给前端。

## 项目结构

```
server/
  index.js        # Express + Socket.io 入口，静态托管 public/
  db.js           # SQLite 建表（node:sqlite）
  auth.js         # 注册/登录（bcryptjs + JWT）
  rooms.js        # 大厅/房间/对局 Socket 逻辑 + AI 调度
  game/rules.js   # Azul 规则引擎（纯函数状态机）
  game/ai.js      # AI 启发式决策（简单/中等/困难，0.5-1.5s 思考延迟）
  game/llm.js     # 大模型 AI（OpenAI 兼容 Chat Completions，失败回退启发式）
public/
  index.html, app.jsx, style.css   # React SPA（Babel 浏览器内编译，免构建）
  vendor/         # React / Babel 本地副本（离线可用）
test/
  engine-smoke.js # 规则引擎冒烟测试：node test/engine-smoke.js
```

## WebSocket 事件

| 事件 | 方向 | 说明 |
|---|---|---|
| `room_list` / `room_update` | S→C | 大厅房间列表 / 房间详情变更 |
| `create_room` `join_room` `leave_room` `add_ai` `remove_ai` `start_game` | C→S | 房间操作（均带回执回调） |
| `game_start` | S→C | 游戏开始 |
| `game_state` | S→C | 全量状态同步（每次操作后广播） |
| `player_action` | C→S | 玩家操作意图 `{source, color, targetLine}` |
| `ai_action` | S→C | AI 自动操作通知 |
| `game_over` | S→C | 游戏结束 + 最终排名 |
