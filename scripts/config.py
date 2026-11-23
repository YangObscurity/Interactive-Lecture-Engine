#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""config.py — 本仓库统一配置层（唯一凭据真源 / Single Source of Truth）。

从 site/config/schema.json 单一真源派生配置项、默认值与秘密清单。
优先级（所有脚本与工具一致）：
    真实环境变量（非空） > 仓库根 .env > 兼容旧文件 (DEPLOY_ENV_FILE / scripts/deploy.local.env) > 代码内默认值
    对于带有别名 (alias) 的配置项，在每一级先尝试标准键名，再尝试别名，然后才进入下一级。
"""

from __future__ import annotations

import json
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
    "expand_path",
    "ConfigError",
    "SECRET_KEYS",
    "DEFAULTS",
]

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
_SCHEMA_PATH = os.path.join(_REPO_ROOT, "site", "config", "schema.json")


class ConfigError(RuntimeError):
    """缺少必需配置时抛出。"""


# ───────────────────────────────────────────────────────────────────────────
# 从 site/config/schema.json 加载元数据
# ───────────────────────────────────────────────────────────────────────────
DEFAULTS: dict[str, str | None] = {}
SECRET_KEYS: frozenset[str] = frozenset()
MASKED_KEYS: frozenset[str] = frozenset()
ALIASES: dict[str, list[str]] = {}
CANONICAL_OF: dict[str, str] = {}

try:
    with open(_SCHEMA_PATH, "r", encoding="utf-8") as _f:
        _schema_data = json.load(_f)

    _secret_set = set()
    _masked_set = set()

    for _s in _schema_data.get("settings", []):
        if _s.get("kind") == "site":
            continue
        _k = _s["key"]
        _d = _s.get("default")
        DEFAULTS[_k] = str(_d) if _d is not None else None

        if _s.get("kind") == "secret":
            _secret_set.add(_k)
        if _s.get("masked"):
            _masked_set.add(_k)

        _aliases = list(_s.get("aliases", []))
        ALIASES[_k] = _aliases
        CANONICAL_OF[_k] = _k
        for _a in _aliases:
            CANONICAL_OF[_a] = _k

    SECRET_KEYS = frozenset(_secret_set)
    MASKED_KEYS = frozenset(_masked_set)
except Exception:
    # 允许在 schema.json 尚未生成时作为空表兜底（运行 config:gen 时）
    pass


# ───────────────────────────────────────────────────────────────────────────
# .env 解析
# ───────────────────────────────────────────────────────────────────────────
def _parse_env_text(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not text:
        return out
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = text.splitlines()
    in_multiline = False
    curr_key = ""
    curr_quote = ""
    accum_val: list[str] = []

    for raw_line in lines:
        if in_multiline:
            close_idx = raw_line.find(curr_quote)
            if close_idx != -1:
                accum_val.append(raw_line[:close_idx])
                out[curr_key] = "\n".join(accum_val)
                in_multiline = False
                curr_key = ""
                curr_quote = ""
                accum_val = []
            else:
                accum_val.append(raw_line)
            continue

        s = raw_line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("export "):
            s = s[len("export "):].lstrip()
        if "=" not in s:
            continue

        key, _, val = s.partition("=")
        key = key.strip()
        if not key:
            continue
        val = val.strip()

        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            out[key] = val[1:-1]
        elif val.startswith('"'):
            in_multiline = True
            curr_key = key
            curr_quote = '"'
            accum_val = [val[1:]]
        elif val.startswith("'"):
            in_multiline = True
            curr_key = key
            curr_quote = "'"
            accum_val = [val[1:]]
        else:
            hash_at = val.find(" #")
            if hash_at != -1:
                val = val[:hash_at].rstrip()
            out[key] = val
    return out


_DOTENV_DATA: dict[str, str] = {}
_LEGACY_DATA: dict[str, str] = {}
_INJECTED_KEYS: set[str] = set()
_INJECTED_VALUES: dict[str, str] = {}


def repo_root() -> str:
    """返回仓库根绝对路径。"""
    return _REPO_ROOT


def _read_file_safe(path: str) -> str | None:
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def load_dotenv(path: str | None = None, override: bool = False, quiet: bool = True) -> str | None:
    """从 .env 载入配置。

    优先级：真实环境变量 > .env 文件。
    override: 是否覆盖已有真实环境变量（默认 False）。
    """
    global _DOTENV_DATA, _LEGACY_DATA
    candidates = [path] if path else [
        os.path.join(os.getcwd(), ".env"),
        os.path.join(_REPO_ROOT, ".env"),
    ]

    loaded_path = None
    for p in candidates:
        content = _read_file_safe(p)
        if content is not None:
            _DOTENV_DATA = _parse_env_text(content)
            loaded_path = p
            break

    # 载入兼容旧文件 (scripts/deploy.local.env 或 DEPLOY_ENV_FILE)
    legacy_file = (
        os.environ.get("DEPLOY_ENV_FILE")
        or _DOTENV_DATA.get("DEPLOY_ENV_FILE")
        or os.path.join(_REPO_ROOT, "scripts", "deploy.local.env")
    )
    legacy_content = _read_file_safe(legacy_file)
    if legacy_content is not None:
        _LEGACY_DATA = _parse_env_text(legacy_content)
    else:
        _LEGACY_DATA = {}

    # 将 .env 写入 os.environ（以保证调用方读取 os.environ 的兼容性）
    n = 0
    for k, v in _DOTENV_DATA.items():
        if override or (k not in os.environ) or (k in _INJECTED_KEYS):
            os.environ[k] = v
            _INJECTED_KEYS.add(k)
            _INJECTED_VALUES[k] = v
            n += 1

    if loaded_path and not quiet:
        print("[config] 已载入 %s（%d 项）" % (loaded_path, n), file=sys.stderr)

    return loaded_path


def _autoload() -> None:
    load_dotenv(quiet=True)


def resolve(key: str) -> tuple[str | None, str, str]:
    """解析一个配置项的最终值、来源和所用键名。

    返回 (value, source, name_used)，其中 source 属于:
    'env' | '.env' | 'legacy' | 'default' | 'unset'
    """
    canonical = CANONICAL_OF.get(key, key)
    aliases = ALIASES.get(canonical, [])
    names = [canonical] + [a for a in aliases if a != canonical]

    # Level 1: 真实环境变量
    for n in names:
        val = os.environ.get(n)
        if val is not None and val != "":
            # 如果来自 _INJECTED 且未被用户修改，属于 .env 来源，在 Level 2 解析
            if n in _INJECTED_KEYS and val == _INJECTED_VALUES.get(n):
                continue
            return val, "env", n

    # Level 2: 仓库根 .env
    for n in names:
        val = _DOTENV_DATA.get(n)
        if val is not None and val != "":
            return val, ".env", n

    # Level 3: 旧版文件 (deploy.local.env)
    for n in names:
        val = _LEGACY_DATA.get(n)
        if val is not None and val != "":
            return val, "legacy", n

    # Level 4: 默认值
    d = DEFAULTS.get(canonical)
    if d is not None and d != "":
        val = os.path.expanduser(d) if canonical == "DEPLOY_SSH_KEY" else d
        return val, "default", canonical

    return None, "unset", canonical


def get(key: str, default: str | None = None) -> str | None:
    """按优先级取配置值（字符串）。"""
    val, source, _ = resolve(key)
    if val is not None and val != "":
        return val
    if default is not None:
        return default
    return None


def require(key: str, hint: str | None = None) -> str:
    """取必需配置值；缺失或为空时抛 ConfigError。"""
    val = get(key)
    if val is None or val == "":
        lines = ["缺少必需配置：%s" % key]
        if hint:
            lines.append("  用途：%s" % hint)
        lines.append("  修复方式（任选其一）：")
        lines.append("    1) 在仓库根 .env 中写入：%s=<值>" % key)
        lines.append("       （模板见 .env.example；.env 已被 .gitignore 忽略，绝不可提交）")
        lines.append("    2) 或用环境变量注入：")
        if os.name == "nt":
            lines.append('       $env:%s = "<值>"' % key)
        else:
            lines.append('       export %s="<值>"' % key)
        lines.append("    ★ 请勿把真实凭据写回代码——本仓库为开源发布，明文凭据会立即泄露。")
        raise ConfigError("\n".join(lines))
    return val


def get_int(key: str, default: int | str | None = None) -> int | None:
    """取整数配置。"""
    raw = get(key, str(default) if default is not None else None)
    if raw is None or raw == "":
        return None
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        raise ConfigError("配置 %s 必须是整数，当前值无法解析：%r" % (key, raw))


def get_bool(key: str, default: bool = False) -> bool:
    """取布尔配置。1/true/yes/on 为 True，其余为 False。"""
    raw = get(key)
    if raw is None or raw == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "y", "on")


def expand_path(value: str | None) -> str | None:
    """把配置里的路径展开为绝对路径（支持 ~ 与相对路径）。"""
    if not value:
        return value
    return os.path.realpath(os.path.expanduser(value))


def mask(value: str | None) -> str:
    """掩码工具：报告/日志里只输出掩码，禁止回显明文。"""
    text = str(value or "")
    if not text:
        return "<empty>"
    parts = text.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts[:1]):
        return "%s.***.***.%s" % (parts[0], parts[3])
    if len(text) <= 6:
        return text[:2] + "***"
    return text[:6] + "****"


def describe(keys: list[str] | None = None) -> list[tuple[str, str]]:
    """返回配置现状摘要，秘密值与敏感字段自动脱敏。"""
    keys = list(keys or DEFAULTS.keys())
    out = []
    for k in keys:
        v = get(k)
        if v is None or v == "":
            out.append((k, "未设置"))
        elif k in SECRET_KEYS:
            out.append((k, "已设置（长度 %d，已脱敏）" % len(v)))
        elif k in MASKED_KEYS:
            out.append((k, mask(v)))
        else:
            out.append((k, v))
    return out


_autoload()
