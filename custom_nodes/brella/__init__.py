"""
Brella ComfyUI Node — AI 出片策展 Agent

在 ComfyUI 工作流中嵌入 Brella 检测管线：
- 手部异常检测 (HandAnomaly)
- 面部结构检测 (Face)
- 构图评分 (Composition)
- 曝光分析 (Exposure)
- 三层分类输出: Bad / Dubious / Desired

== 安装 ==
1. 将本目录 (custom_nodes/brella/) 复制到 ComfyUI/custom_nodes/ 下
2. 确保 `brella` CLI 可用：
   - 方法 A: npm link (在 brella 项目目录运行)
   - 方法 B: 设置环境变量 BRELLA_CLI=/path/to/brella/dist/cli.js
3. 重启 ComfyUI
"""

import os
import json
import subprocess
import tempfile
import shutil

import torch
import numpy as np
from PIL import Image
from pathlib import Path


# ============================================================
# 工具函数
# ============================================================

def _find_brella_cli() -> str:
    """查找 brella CLI 入口"""
    # 1. 环境变量优先
    env_cli = os.environ.get("BRELLA_CLI")
    if env_cli and Path(env_cli).exists():
        return env_cli

    # 2. 检查本项目旁边是否有 brella 项目
    node_dir = Path(__file__).parent.resolve()
    # 尝试向上查找 brella 项目
    for candidate in [
        node_dir / ".." / ".." / ".." / "src" / "cli.ts",  # 开发目录结构
        node_dir / ".." / ".." / "dist" / "cli.js",        # 编译后
    ]:
        resolved = candidate.resolve()
        if resolved.exists():
            return str(resolved)

    # 3. 系统 PATH 中找 brella
    brella_path = shutil.which("brella")
    if brella_path:
        return brella_path

    # 4. 常见安装路径
    for p in [
        "/opt/data/home/projects/brella/dist/cli.js",
        "/usr/local/bin/brella",
        os.path.expanduser("~/projects/brella/dist/cli.js"),
    ]:
        if Path(p).exists():
            return p

    raise FileNotFoundError(
        "未找到 brella CLI。请设置环境变量 BRELLA_CLI 指向 brella/dist/cli.js，"
        "或将 brella 项目置于 ComfyUI 附近，或运行 npm link"
    )


def _torch_to_pil(tensor: torch.Tensor) -> Image.Image:
    """将 ComfyUI 的 torch 张量转换为 PIL Image"""
    i = 255.0 * tensor.cpu().numpy().squeeze()
    img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
    return img


# ============================================================
# Brella 分类节点
# ============================================================

class BrellaClassifyNode:
    """
    ComfyUI 节点：对图像执行 Brella 检测管线，输出三层分类结果

    输入：
      - images: 图像张量 (来自任何采样器的输出)
    输出：
      - classification_json: 完整分类结果的 JSON 字符串
      - layer: 分类层名称 (bad / dubious / desired)
      - summary: 人类可读的摘要
      - scores: 各维度评分摘要
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "hand_threshold": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05},
                ),
                "face_threshold": (
                    "FLOAT",
                    {"default": 0.6, "min": 0.0, "max": 1.0, "step": 0.05},
                ),
                "comp_threshold": (
                    "FLOAT",
                    {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05},
                ),
                "exp_threshold": (
                    "FLOAT",
                    {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05},
                ),
            },
            "optional": {
                "save_image": ("BOOLEAN", {"default": True}),
                "filename_prefix": ("STRING", {"default": "brella_classified"}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("classification_json", "layer", "summary", "scores")
    FUNCTION = "classify"
    CATEGORY = "Brella / 策展"
    OUTPUT_NODE = True

    def classify(
        self,
        images: torch.Tensor,
        hand_threshold: float = 0.5,
        face_threshold: float = 0.6,
        comp_threshold: float = 0.5,
        exp_threshold: float = 0.3,
        save_image: bool = True,
        filename_prefix: str = "brella_classified",
    ) -> tuple[str, str, str, str]:
        """
        对图像执行 Brella 检测管线

        参数：
            images: ComfyUI 图像张量 (batch, height, width, channel)
            其他: 检测阈值

        返回：
            (classification_json, layer, summary, scores)
        """
        temp_dir = Path(tempfile.mkdtemp(prefix="brella_"))
        results = []

        try:
            brella_cli = _find_brella_cli()

            for i in range(images.shape[0]):
                img = _torch_to_pil(images[i])

                # 保存临时 PNG 文件
                if images.shape[0] > 1:
                    temp_path = temp_dir / f"brella_input_{i:04d}.png"
                else:
                    temp_path = temp_dir / "brella_input.png"

                img.save(str(temp_path), "PNG")

                # 构建 CLI 命令
                cmd = [
                    "node",
                    brella_cli,
                    "classify",
                    str(temp_path),
                    "--hand-threshold", str(hand_threshold),
                    "--face-threshold", str(face_threshold),
                    "--comp-threshold", str(comp_threshold),
                    "--exp-threshold", str(exp_threshold),
                ]

                # 运行检测
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )

                if proc.returncode != 0:
                    result = {
                        "error": proc.stderr.strip(),
                        "image_index": i,
                    }
                else:
                    try:
                        result = json.loads(proc.stdout.strip())
                    except json.JSONDecodeError:
                        result = {
                            "error": f"Parse error: {proc.stdout[:200]}",
                            "image_index": i,
                        }

                results.append(result)

            # 汇总结果
            if len(results) == 1:
                r = results[0]
                classification_json = json.dumps(r, indent=2, ensure_ascii=False)
                layer = r.get("layer", "error")
                if "error" in r:
                    summary = f"[ERROR] {r['error']}"
                else:
                    summary = (
                        f"[{r.get('layer', 'unknown').upper()}] "
                        f"conf={r.get('confidence', 0):.2f} "
                        f"seed={r.get('seed', '?')} "
                        f"model={r.get('model', '?')[:20]} "
                        f"| hand={r.get('scores', {}).get('handAnomaly', 0):.2f} "
                        f"face={r.get('scores', {}).get('faceAnomaly', 0):.2f} "
                        f"comp={r.get('scores', {}).get('compositionScore', 0):.2f} "
                        f"exp={r.get('scores', {}).get('exposureScore', 0):.2f}"
                    )
                scores = json.dumps(r.get("scores", {}), ensure_ascii=False)

            else:
                # 批量结果
                layers = [r.get("layer", "error") for r in results]
                batch_counts = {
                    "bad": layers.count("bad"),
                    "dubious": layers.count("dubious"),
                    "desired": layers.count("desired"),
                }
                classification_json = json.dumps(results, indent=2, ensure_ascii=False)
                layer = " | ".join(
                    f"{k}: {v}" for k, v in batch_counts.items() if v > 0
                )
                summary = (
                    f"Batch {len(results)} images: "
                    + ", ".join(f"{k}={v}" for k, v in batch_counts.items() if v > 0)
                )
                scores = json.dumps(
                    {
                        f"img_{i}": r.get("scores", {})
                        for i, r in enumerate(results)
                    },
                    ensure_ascii=False,
                )

            return (classification_json, layer, summary, scores)

        except FileNotFoundError as e:
            error_json = json.dumps({"error": str(e)})
            return (error_json, "error", str(e), "{}")

        except subprocess.TimeoutExpired:
            error_json = json.dumps({"error": "Brella CLI timed out (60s)"})
            return (error_json, "error", "Brella CLI timed out after 60s", "{}")

        except Exception as e:
            error_json = json.dumps({"error": str(e)})
            return (error_json, "error", f"Unexpected error: {e}", "{}")

        finally:
            # 清理临时文件
            if temp_dir.exists():
                shutil.rmtree(str(temp_dir))


# ============================================================
# 节点注册
# ============================================================

NODE_CLASS_MAPPINGS = {
    "BrellaClassify": BrellaClassifyNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BrellaClassify": "Brella 策展检测 🫂",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
