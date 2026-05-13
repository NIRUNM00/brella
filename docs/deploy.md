# Brella 部署指南

> 将 Brella API 部署为常驻服务，配合 Gallery 或独立使用。

---

## 配置加载链

```
CLI 参数 (--port, --db)  # 最高优先级
    ↓
环境变量 (BRELLA_PORT, BRELLA_DB_PATH)
    ↓
配置文件 (.brellarc.json / .brellarc)
    ↓
默认值 (port=8898, db=./brella.db)
```

### 配置文件

Brella 自动搜索以下路径（按优先级）:
1. `$BRELLA_CONFIG` 环境变量指向的路径
2. `./.brellarc` / `./.brellarc.json`（项目目录）
3. `~/.brellarc` / `~/.brellarc.json`

```bash
# 初始化生成配置模板
npx brella init --gen

# 修改配置后启动
vim .brellarc
```

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 启动
npm run serve                # 前台运行（port 8898）
npm run serve -- -p 8899     # 改端口
node dist/api/server.js --db /path/to/db.sqlite

# 4. 验证
curl http://localhost:8898/v1/health
# → {"status":"ok","version":"0.1.0-alpha"}
```

---

## 生产部署

### 方法一：部署脚本

```bash
# 启动
bash deploy/start_brella.sh

# 指定端口和数据库
bash deploy/start_brella.sh -p 8899 -d /data/brella.db

# 环境变量方式
BRELLA_PORT=8899 BRELLA_DB_PATH=/data/brella.db bash deploy/start_brella.sh
```

### 方法二：保活守护（推荐）

```bash
# 在 tmux/screen 中启动保活
bash deploy/brella-keepalive.sh &

# 或写入系统服务
# 见下方 systemd 单元文件
```

### systemd 服务（Linux）

```ini
# /etc/systemd/system/brella.service
[Unit]
Description=Brella AI Curation Agent
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/brella
ExecStart=/usr/bin/node dist/api/server.js
Restart=on-failure
RestartSec=5
Environment=BRELLA_PORT=8898
Environment=BRELLA_DB_PATH=/opt/data/brella.db

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable brella
sudo systemctl start brella
```

### Docker 部署

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 8898
CMD ["node", "dist/api/server.js"]
```

```bash
docker build -t brella .
docker run -d -p 8898:8898 -v /data:/data brella
```

---

## 环境变量参考

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `BRELLA_PORT` | API 端口 | `8898` |
| `BRELLA_DB_PATH` | 数据库路径 | `./brella.db` |
| `BRELLA_CONFIG` | 配置文件路径 | — |
| `PORT` | 兼容旧名端口 | `8898` |
| `DB_PATH` | 兼容旧名数据库路径 | `./brella.db` |

---

## 与 Gallery 集成

Gallery 通过反向代理访问 Brella:

1. Gallery 启动时设置环境变量:
   ```
   BRELLA_URL=http://localhost:8898
   ```

2. Gallery `gallery_server.py` 提供 `/api/brella/*` 路由，自动代理到 Brella

3. 前端 JS 用相对路径 `/api/brella/` 调用

---

## 日志

- `logs/brella.log` — Brella 服务器日志
- `logs/brella-keepalive.log` — 保活守护日志
- 日志自动轮转: 前一天的日志保存为 `.old`

---

## API 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/health` | 健康检查 |
| GET | `/v1/summary` | 全局概览统计 |
| GET | `/v1/stats` | Wilson Score 排名 |
| GET | `/v1/stats/models` | 按模型聚合排名 |
| GET | `/v1/stats/by-batch` | 按批次统计 |
| GET | `/v1/batches` | 批次列表 |
| GET | `/v1/export` | 导出决策（?format=csv\|json） |
| POST | `/v1/decide` | 单条决策 |
| POST | `/v1/decide/batch` | 批量决策 |
| GET | `/` | 独立 Dashboard |
