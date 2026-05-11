# Brella 使用文档

> AI 出片策展 Agent — 筛选、记忆、决策

---

## 目录

1. [安装](#安装)
2. [快速开始](#快速开始)
3. [CLI 参考](#cli-参考)
4. [三层分类体系](#三层分类体系)
5. [Wilson Score 引擎](#wilson-score-引擎)
6. [Prompt 原型管理](#prompt-原型管理)
7. [ComfyUI 集成](#comfyui-集成)
8. [最佳实践](#最佳实践)

---

## 安装

### 前置要求

- Node.js >= 18
- npm

### 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/NIRUNM00/brella/main/scripts/install.sh | bash
```

### 手动安装

```bash
git clone git@github.com:NIRUNM00/brella.git ~/.brella
cd ~/.brella
npm install
npm run build
npm link        # 注册 brella CLI
brella init      # 初始化数据库
```

### ComfyUI 自定义节点

```bash
# 将节点复制到 ComfyUI 的 custom_nodes 目录
cp -r ~/.brella/custom_nodes/brella /path/to/ComfyUI/custom_nodes/
# 重启 ComfyUI
```

---

## 快速开始

### 1. 初始化

```bash
brella init
```

初始化会在当前目录创建 `brella.db`（SQLite 数据库），存储所有决策记录和偏好。

### 2. 策展一批图片

```bash
brella curate ./batch-output --tag my-batch-01
```

Brella 会扫描目录中的图像（支持 .png/.jpg/.jpeg/.webp），运行检测管线并生成简报：

```
📋 简报
  Batch: batch_20260511_120000
  200 张图像 → Bad: 32 (16.0%), Dubious: 128 (64.0%), Desired: 40 (20.0%)
```

**三层分类说明：**
- **Bad** — 崩手/崩脸/结构缺陷，默认淘汰
- **Dubious** — 构图/光线有疑问，按 Wilson Score 排序推荐优先审
- **Desired** — 无明显缺陷，高概率保留

### 3. 记录决策

```bash
# 接受某张（由种子号标识）
brella decide 42 accept -p "cat in sunlight" -n "good composition"

# 拒绝
brella decide 7 reject -p "cat in sunlight" -n "hand anomaly"

# 带原型标签记录（自动将此 prompt 关联到原型）
brella decide 42 accept -p "cat in sunlight" -n "good composition" -a portrait
```

### 4. 查看统计

```bash
# Wilson Score 排名 Top 10
brella stats --top 10

# 查看某种子的决策历史
brella detail 42

# 查看整体简报
brella brief
```

---

## CLI 参考

### `brella init`

初始化数据库。创建 4 张表：`seed_preferences`, `prompt_archetypes`, `image_metadata`, `wilson_scores`。

### `brella curate <directory>`

**参数：**
| 参数 | 说明 | 默认值 |
|------|------|--------|
| `<directory>` | 图像目录路径 | 必填 |
| `-t, --tag <tag>` | 批次标识 | auto |
| `-a, --alpha <n>` | Wilson Score α 参数 | 0.05 |

**输出：** 分层简报（Bad / Dubious / Desired），包含各层数量和占比。

> 当前版本检测器使用启发式算法 | 下一版本将集成 HandEval 等外部模型

### `brella decide <seed> <action>`

**参数：**
| 参数 | 说明 |
|------|------|
| `<seed>` | 种子号（整数） |
| `<action>` | accept / reject / skip |
| `-p, --prompt <text>` | 关联 prompt |
| `-n, --note <text>` | 备注 |
| `-a, --archetype <label>` | 原型标签（自动关联） |

决策记录后，Wilson Score 自动更新。

### `brella detail <identifier>`

查看某张/某组图像的详细信息。支持按种子号或文件名搜索。

### `brella stats`

**选项：** `--top <n>`（默认 10）

显示 Wilson Score 排名，含分数条形图。

### `brella brief`

查看整体统计简报：总决策数、高分种子等。

### `brella archetype`

原型管理子命令体系：

```bash
# 设置 prompt 原型
brella archetype set "cat in sunlight" portrait

# 查询原型
brella archetype get "cat in sunlight"

# 列出所有原型
brella archetype list

# 搜索
brella archetype search portrait
```

### `brella classify <imagePath>`

**选项：**
| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--pretty` | 格式化 JSON 输出 | 压缩 |
| `--hand-threshold <n>` | 手部检测阈值 | 0.5 |
| `--face-threshold <n>` | 面部检测阈值 | 0.6 |
| `--comp-threshold <n>` | 构图阈值 | 0.5 |
| `--exp-threshold <n>` | 曝光阈值 | 0.3 |

输出 JSON（供 ComfyUI 节点调用）：

```json
{
  "file": "/path/to/image.png",
  "seed": 77777,
  "layer": "dubious",
  "confidence": 0.73,
  "scores": {
    "handAnomaly": 0.12,
    "faceAnomaly": 0.08,
    "compositionScore": 0.45,
    "exposureScore": 0.82
  },
  "reasons": ["构图评分偏低"],
  "processingTimeMs": 42
}
```

---

## 三层分类体系

| 层级 | 颜色 | 含义 | 默认处理 |
|------|------|------|----------|
| **Bad** | 🔴 红 | 手部异常 ≥ 阈值 / 面部异常 ≥ 阈值 | 自动淘汰，不审 |
| **Dubious** | 🟡 黄 | 构图或曝光低于疑值线 | 按 Wilson Score 排序，优先审 |
| **Desired** | 🟢 绿 | 全部指标正常 | 高概率保留，按偏好排序 |

**检测维度：**

1. **手部解剖**（HandAnomaly: 0~1）— 检测异常手部结构
2. **面部结构**（FaceAnomaly: 0~1）— 检测崩脸/面部畸形
3. **构图评分**（CompositionScore: 0~1）— 中心度、三分法则
4. **曝光评分**（ExposureScore: 0~1）— 直方图分布、过曝/欠曝

> 当前版本使用启发式算法（local-heuristic 模式），无需 GPU 即可运行。
> 后续版本将支持 remote-api 模式，集成 HandEval 等外部模型。

---

## Wilson Score 引擎

Brella 使用 **Wilson Score 下限**进行置信度加权排序，解决"少量样本下评分不可信"的问题。

### 计算方式

```
n=总判断次数, p=接受率, z=正态分布分位数(α=0.05→z=1.96)

score = (p + z²/2n - z * sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)
```

### 效果

- 1 次接受，0 次拒绝 → score = 0.206（置信度低，自动降权）
- 10 次接受，2 次拒绝 → score = 0.573（置信度中等）
- 100 次接受，20 次拒绝 → score = 0.754（置信度高）

### CLI 查看

```bash
brella stats --top 10
# seed    77777 | 85.3% ████████████████░░ (102👍/18👎)
# seed      42 | 20.6% ████░░░░░░░░░░░░░░ (  1👍/ 0👎)
```

---

## Prompt 原型管理

原型（Archetype）是对 prompt 进行分类的标签系统，帮助跨批次识别相似出图风格。

### 使用场景

```bash
# 创建原型
brella archetype set "cat in sunlight, cozy window" portrait

# 查看同一原型下所有 prompt
brella archetype list

# 搜索所有 portrait 相关 prompt
brella archetype search portrait
```

### 自动标记

在 `decide` 时添加 `--archetype` 选项，自动将 prompt 关联到指定原型：

```bash
brella decide 42 accept -p "cat in sunlight" -n "nice lighting" -a portrait
```

原型关联后，下次同类 prompt 的 Wilson Score 会优先参考同原型的决策历史。

---

## ComfyUI 集成

### 节点安装

```bash
cp -r ~/.brella/custom_nodes/brella /path/to/ComfyUI/custom_nodes/
```

### 节点功能

Brella ComfyUI 节点对每张出图自动执行：

1. **读取 PNG 元数据**（seed, prompt, cfg, model）
2. **运行检测管线**（手部、面部、构图、曝光）
3. **输出分类结果**（Bad / Dubious / Desired）

### 节点输入

| 输入 | 类型 | 说明 |
|------|------|------|
| `images` | IMAGE | 输入图像 tensor |
| `hand_threshold` | FLOAT | 手部异常阈值（默认 0.5） |
| `face_threshold` | FLOAT | 面部异常阈值（默认 0.6） |
| `comp_threshold` | FLOAT | 构图疑值阈值（默认 0.5） |
| `exp_threshold` | FLOAT | 曝光疑值阈值（默认 0.3） |

### 节点输出

| 输出 | 类型 | 说明 |
|------|------|------|
| `classification_json` | STRING | 完整检测 JSON |
| `layer` | STRING | bad / dubious / desired |
| `summary` | STRING | 可读摘要 |
| `scores` | STRING | 各维度分数 |

### 工作流示例

在 ComfyUI 中：
```
LoadImage → BrellaNode → ShowText(classification_json)
                        → ShowText(summary)
```

Brella 节点会自动从 LoadImage 输出的文件名解析 PNG 元数据。

---

## 最佳实践

### 批次管理

```bash
# 为每批出图打上唯一 tag
brella curate ./batch-01 --tag v1-pony-girl-01
brella curate ./batch-02 --tag v1-pony-girl-02

# 跨批次查询
brella detail 42
# 显示该种子在所有 batch 中的决策历史
```

### 决策策略

- **优先进 Desired 层但不放心** → 查看详情后再补 `reject`
- **Dubious 层按排名审** → Wilson Score 最高的最可能被保留
- **每周归档一次** → `brella brief` 了解全局

### 与 ComfyUI 配合

- 安装节点后，每张出图自动带分类标签
- 将 Bad 层接入自动丢弃管线（`B票/删除` 等操作）
- Desired 层直接进入候选集

### 数据目录

```
brella.db                # SQLite 数据库（决策/偏好/原型）
custom_nodes/brella/     # ComfyUI 自定义节点
docs/                    # 文档
scripts/install.sh       # 一键安装脚本
```

---

> Brella 不出图，不出评分 — 它帮你记住你上次喜欢的是什么。
