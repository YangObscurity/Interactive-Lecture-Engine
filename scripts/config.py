#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""config.py — 本仓库**统一配置层**（唯一凭据真源 / Single Source of Truth）。

═══════════════════════════════════════════════════════════════════════════════
为什么要做这一层（背景与动机）
═══════════════════════════════════════════════════════════════════════════════
本仓库准备开源发布。历史上为了图方便，Notion 集成令牌、服务器公网 IP、SSH 端口、
生产域名、SSH 私钥路径、Notion 数据库 ID
被**硬编码**散落在十余个脚本里。私有库时代这尚可容忍，一旦公开即等于把凭据
拱手送出（且 git 历史不可逆）。

因此立下一条工程铁律：
    **任何脚本都不得再出现可用的凭据明文；一律经本模块统一取值。**

同时必须**保住原有功能与语义**，所以本模块刻意做到：
  1. **零第三方依赖**：只用 Python 标准库（本仓库脚本常跑在精简沙箱 / CI 里，
     实测装不上 paramiko、PyPI 不可达），因此绝不 import 任何 pip 包。
  2. **不破坏原有优先级**：原来的脚本普遍遵循
     `命令行参数 > 环境变量 > 默认值/常量`。
     本模块负责「环境变量 > 默认值」这一层，调用方拿到的仍是普通字符串，
     再由调用方套上自己已有的 `--token` / `--host` 参数覆盖逻辑即可，
     原有 `--token` 行为**逐字保留**。
  3. **零副作用**：import 本模块不会连网、不会抛异常；只有显式调用
     `require()` 时才会因为缺配置而报错，且错误信息必须**足够清晰**
     （告诉使用者缺哪个变量、去哪里填），而不是一个 KeyError 堆栈。

═══════════════════════════════════════════════════════════════════════════════
配置来源与优先级
═══════════════════════════════════════════════════════════════════════════════
    真实进程环境变量  >  .env 文件  >  代码内默认值（本模块 DEFAULTS）

为什么把「真实环境变量」排在 `.env` 之前：CI / 容器编排（Docker、GitHub Actions）
注入的变量代表运行时真实意图，本地 `.env` 只是开发者便利文件，
若让 `.env` 覆盖真实环境变量，会出现「CI 里明明注入了新值却仍走本地旧值」的
幽灵问题。这也是 python-dotenv 等库的 `override=False` 默认语义。

`load_dotenv()` 只在 .env 里键**尚不存在于 os.environ** 时才写入，
因此不会污染或覆盖调用方已经设好的环境。

═══════════════════════════════════════════════════════════════════════════════
安全须知
═══════════════════════════════════════════════════════════════════════════════
  * `.env` 绝不可入库（已在根 `.gitignore` 中忽略）；仓库只保留 `.env.example`
    占位模板。
  * 本模块**不会**打印任何配置值的明文；`describe()` 对密钥类字段只回显
    「已设置 / 未设置」与长度，避免误把令牌写进日志或截图。
  * 令牌一旦在公开仓库泄露过，**必须去 Notion 后台吊销重建**——
    改代码只是止血，rotation 才是根治。
"""

from __future__ import annotations

import os
import sys

__all__ = [
    "get",
    "require",
    "get_bool",
    "get_int",
    "load_dotenv",
    "describe",
    "repo_root",
    "ConfigError",
    "SECRET_KEYS",
]

# ───────────────────────────────────────────────────────────────────────────
# 仓库根定位
# ───────────────────────────────────────────────────────────────────────────
# 本文件位于 <repo>/scripts/config.py，故上溯两级即仓库根。
# 用真实路径（realpath）解析，兼容符号链接与不在仓库内的工作目录调用。
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)

# `.env` 的查找顺序：先从「当前工作目录」（开发者通常就在仓库根执行脚本，
# 也便于给不同项目放不同 .env），再回退到「仓库根定位所得」。
# 之所以不写死单一位置：脚本既可能被 `python scripts/xxx.py` 从仓库根调用，
# 也可能被 CI 在别处调用，两条候选路径能覆盖绝大多数真实场景。
_ENV_CANDIDATES = (
    os.path.join(os.getcwd(), ".env"),
    os.path.join(_REPO_ROOT, ".env"),
)


class ConfigError(RuntimeError):
    """缺少必需配置时抛出。

    刻意继承 RuntimeError 而非 KeyError：这是**配置缺失**（运维/环境问题），
    不是编程错误，调用方 `except Exception` 也能正常兜住。
    """


# ───────────────────────────────────────────────────────────────────────────
# 默认值表
# ───────────────────────────────────────────────────────────────────────────
# 原则：**默认值里绝不出现任何真实私有信息**。
#   - 服务器地址：给 localhost / 空串，真实值由环境注入；
#   - SSH 私钥：给跨平台的 ~/.ssh/id_ed25519（由 os.path.expanduser 展开），
#     这样 Windows / Linux / macOS 都能用，且不再泄露任何用户名；
#   - 令牌 / 数据库 ID：默认 None（无默认，缺失即报错），杜绝回退到明文。
DEFAULTS = {
    # ── Notion 只读接口 ────────────────────────────────────────────────────
    # 集成令牌。**没有默认值**：一旦给了默认值就等于把凭据写进代码。
    "NOTION_TOKEN": None,
    # Notion REST API 版本号。这不是秘密，属于协议约定，可安全内置。
    "NOTION_API_VERSION": "2022-06-28",
    # 知识节点数据库 ID。属于私有工作区标识，**无默认值**，由环境注入。
    "NOTION_DB_ID": None,
    # 写入/归档目标页面 ID（notion_sync_archive.py 使用）。同样无默认值。
    "NOTION_ARCHIVE_PAGE_ID": None,

    # ── 部署目标（远端生产机）────────────────────────────────────────────────
    # 主机默认 localhost：宁可连错本地也不要泄露真实 IP，且缺配置时报错清晰。
    "DEPLOY_HOST": "localhost",
    "DEPLOY_PORT": "22",
    "DEPLOY_USER": "root",
    # 跨平台默认私钥路径。os.path.expanduser 在 Windows 会展开为
    # C:\Users\<当前用户>\.ssh\id_ed25519，在 Linux/macOS 为 /home/<u>/.ssh/...，
    # 因此**不需要也不允许**再写死某个 Windows 用户名。
    "DEPLOY_SSH_KEY": os.path.join("~", ".ssh", "id_ed25519"),
    # 私钥**内容**（PEM 文本）。沙箱 / CI 挂不了文件时用环境变量整段注入。
    "DEPLOY_SSH_KEY_PEM": "",
    # 站点根目录 / 远端部署目录。
    "DEPLOY_WEBROOT": "",
    # 本地待部署的 dist 目录。
    "DEPLOY_LOCAL_DIST": "",
    # 生产域名。空默认值——所有 URL 拼接处必须经由本键注入。
    "DEPLOY_SITE_DOMAIN": "",
    # 认证网关域名（Authelia 登录页）。旧脚本里与站点域名并列硬编码过。
    "DEPLOY_AUTH_DOMAIN": "",

    # ── 本地构建基线配置 ───────────────────────────────────────────────────
    # 支持通过环境变量注入自定义构建产物比对目录。
    "DEPLOY_SOURCE_DIST": "",

    # ── 远端微服务 ─────────────────────────────────────────────────────────
    # 辅助工具服务监听端口。
    "LECTURE_TOOLS_PORT": "8099",
    "LECTURE_TOOLS_HOST": "127.0.0.1",
    # 远端 Web 服务配置文件路径前缀。
    "NGINX_SITES_AVAILABLE": "/etc/nginx/sites-available",

    # ── 源码镜像同步（sync.py 用）───────────────────────────────────────────
    # 真实工作副本（VitePress 站点源码所在目录）。默认 None / 空：
    # 由命令行 --site-src 或环境变量 LECTURE_SITE 指定；
    # 未指定时 sync.py 会退化为以本仓库 site/ 为工作副本的沙箱模式（SELF_MIRROR）。
    "LECTURE_SITE": "",
    # 上游知识库工作副本根目录。由环境变量注入，默认留空。
    "PROJECT_MEMORY": "",
    # 本地知识图谱 JSON 路径（upload_graph_to_server.py 用）。
    # 留空则回退到仓库内标准位置 site/docs/public/notion_knowledge_graph.json。
    "GRAPH_LOCAL_PATH": "",
    # 远端微服务源码落地路径（deploy_backend_notion_sync.py 用）。
    # 默认值与远端服务约定一致，可用环境变量覆盖以便换目录部署。
    "REMOTE_SERVER_PY": "/opt/lecture-tools/server.py",
    # 部署目标机器的显示名（仅用于日志/文档描述，不参与连接）。
    # 历史上在计划文档里写作真实主机名，现由占位符代替。
    "DEPLOY_HOST_LABEL": "",

    # ── 测试目标 ───────────────────────────────────────────────────────────
    # 端到端测试打的生产 URL 前缀；空值则测试脚本会提示缺配置而非硬编码域名。
    "TEST_BASE_URL": "",
    # Notion 进度回写 API 的完整端点（test_date_lifecycle.py 用）。
    # 历史上硬编码了生产域名，现默认空 —— 缺失时脚本明确报错而非请求写死的站点。
    "TEST_SYNC_API_URL": "",
    # E2E 测试用的 Notion 页面 ID。**无默认值** —— 它是具体的私人页面标识，
    # 内置默认值等于泄露个人数据（历史上硬编码过某个真实 page id）。
    "TEST_PAGE_ID": None,
}

# 哪些键属于**秘密**：describe() 会对其脱敏，只回显设置状态而不回显内容。
# 注意 DEPLOY_SSH_KEY_PEM 也在列——它本身就是私钥正文。
SECRET_KEYS = frozenset({
    "NOTION_TOKEN",
    "NOTION_DB_ID",
    "NOTION_ARCHIVE_PAGE_ID",
    "TEST_PAGE_ID",
    "DEPLOY_SSH_KEY_PEM",
})


# ───────────────────────────────────────────────────────────────────────────
# .env 加载
# ───────────────────────────────────────────────────────────────────────────
def _parse_env_line(line):
    """把 `.env` 的一行解析成 (key, value)；不是有效赋值行则返回 None。

    刻意手写而不引入 python-dotenv：本仓库要求零第三方依赖。
    支持的真实用法：空行、`#` 注释、可选 `export ` 前缀、
    单/双引号包裹值、值内含 `=`、行尾 `#` 注释（仅裸值时生效）。
    """
    s = line.strip()
    if not s or s.startswith("#"):
        return None
    if s.startswith("export "):
        s = s[len("export "):].lstrip()
    if "=" not in s:
        return None

    key, _, value = s.partition("=")
    key = key.strip()
    if not key:
        return None

    value = value.strip()
    # 引号包裹：引号内原样保留（含 # 与空格），只去掉最外层引号。
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    else:
        # 裸值：行尾 `#` 视为注释起点，但要求 # 前面是空白，避免误伤
        # 形如 `PASSWORD=abc#def` 这种不含空格的合法值。
        hash_at = value.find(" #")
        if hash_at != -1:
            value = value[:hash_at].rstrip()
        # 行内 Windows 路径反斜杠不做转换（避免 \t \n 被误解为转义）。
    return key, value


def load_dotenv(path=None, override=False, quiet=True):
    """从 `.env` 载入配置到 `os.environ`。

    参数：
        path     —— 显式指定 .env 路径；为 None 时按 `_ENV_CANDIDATES` 顺序探测。
        override —— 是否允许 .env 覆盖已存在的真实环境变量。
                    **默认 False**（真实环境变量优先，见模块头「优先级」说明）。
        quiet    —— 是否静默。默认 True：脚本工具不该因为「没有 .env」而刷噪声。

    返回：实际载入的文件路径；没有可载入的文件则返回 None。
    """
    targets = [path] if path else list(_ENV_CANDIDATES)
    loaded = None

    for p in targets:
        if not p or not os.path.isfile(p):
            continue
        try:
            # utf-8-sig：容忍 Windows 记事本写出的 BOM，否则首行键名会带 \ufeff。
            with open(p, "r", encoding="utf-8-sig") as f:
                lines = f.readlines()
        except OSError as e:
            if not quiet:
                print("[config] 读取 .env 失败（已忽略）：%s（%s）" % (p, e), file=sys.stderr)
            continue

        n = 0
        for line in lines:
            parsed = _parse_env_line(line)
            if not parsed:
                continue
            key, value = parsed
            # 真实环境变量优先：已存在且不要求 override 时跳过。
            if not override and key in os.environ:
                continue
            os.environ[key] = value
            n += 1

        loaded = p
        if not quiet:
            print("[config] 已载入 %s（%d 项，%s覆盖既有环境变量）"
                  % (p, n, "" if override else "不"), file=sys.stderr)
        # 只载入第一个命中的文件，避免两份 .env 相互干扰。
        break

    return loaded


def _autoload():
    """import 时自动尝试载入 .env（找不到就静默跳过）。

    为什么要自动：调用方（十几个历史脚本）不该每处都记得写 `load_dotenv()`。
    自动载入让「把 .env 放仓库根」这一个动作即可让全部脚本生效，
    同时因为 override=False，绝不覆盖 CI 注入的真实变量。
    """
    load_dotenv(quiet=True)


def repo_root():
    """返回仓库根绝对路径（由本文件位置推导，不受当前工作目录影响）。"""
    return _REPO_ROOT


# ───────────────────────────────────────────────────────────────────────────
# 取值 API
# ───────────────────────────────────────────────────────────────────────────
def get(key, default=None):
    """取配置值（字符串）。

    解析顺序：真实环境变量 > 已载入的 .env（其实已并入 os.environ）> default
              > DEFAULTS[key]。

    细节：空字符串被视为「未设置」并继续向下一级回退。
    为什么——环境变量里 `DEPLOY_HOST=` 这种空赋值，语义上就是「我没填」，
    若当成有效值会让脚本拿空串去连接，产生极其难查的故障。
    """
    val = os.environ.get(key)
    if val is not None and val != "":
        return val
    if default is not None:
        return default
    d = DEFAULTS.get(key)
    if d is None:
        return None
    # 默认值里的 `~` 需展开（DEPLOY_SSH_KEY 依赖这一点实现跨平台）。
    if key == "DEPLOY_SSH_KEY":
        return os.path.expanduser(d)
    return d


def require(key, hint=None):
    """取必需配置值；缺失或为空时抛 `ConfigError`，并给出可执行的修复指引。

    hint：补充说明（例如「部署脚本需要它连接生产机」），会拼进错误信息。
    """
    val = get(key)
    if val is None or val == "":
        lines = [
            "缺少必需配置：%s" % key,
        ]
        if hint:
            lines.append("  用途：%s" % hint)
        lines.append("  修复方式（任选其一）：")
        lines.append("    1) 在仓库根 `.env` 中写入：%s=<值>" % key)
        lines.append("       （模板见 `.env.example`；`.env` 已被 .gitignore 忽略，绝不可提交）")
        lines.append("    2) 或用环境变量注入：")
        if os.name == "nt":
            lines.append('       $env:%s = "<值>"' % key)
        else:
            lines.append('       export %s="<值>"' % key)
        lines.append("    ★ 请勿把真实凭据写回代码——本仓库为开源发布，明文凭据会立即泄露。")
        raise ConfigError("\n".join(lines))
    return val


def get_int(key, default=None):
    """取整数配置（如端口）。非法整数会给出明确报错而非 ValueError 裸栈。"""
    raw = get(key, default)
    if raw is None or raw == "":
        return None
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        raise ConfigError(
            "配置 %s 必须是整数，当前值无法解析：%r" % (key, raw)
        )


def get_bool(key, default=False):
    """取布尔配置。接受 1/true/yes/on（不分大小写）为真，其余为假。"""
    raw = get(key)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "y", "on")


def expand_path(value):
    """把配置里的路径展开为绝对路径（支持 `~` 与相对路径）。

    单独抽出来是为了让「私钥路径」在各脚本中走同一条规范化逻辑：
    历史上各脚本各写各的（有的是原样 raw 字符串，有的 realpath），
    统一后 `~/.ssh/id_ed25519` 在任何平台都能正确落地。
    """
    if not value:
        return value
    return os.path.realpath(os.path.expanduser(value))


def describe(keys=None):
    """返回配置现状摘要（供 `--show-config` 之类自检使用），**秘密值自动脱敏**。

    只回显「已设置(长度 N) / 未设置」，绝不回显令牌或私钥正文——
    这是防止「调试打印把凭据写进日志」这类二次泄露的关键设计。
    """
    keys = list(keys or DEFAULTS.keys())
    out = []
    for k in keys:
        v = get(k)
        if v is None or v == "":
            out.append((k, "未设置"))
        elif k in SECRET_KEYS:
            out.append((k, "已设置（长度 %d，已脱敏）" % len(v)))
        else:
            out.append((k, v))
    return out


# import 即尝试载入 .env：让历史脚本无需改动调用姿势即可受益。
_autoload()
