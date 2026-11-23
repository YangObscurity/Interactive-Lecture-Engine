#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy_config.py — 部署基建参数入口（兼容层）。

取值优先级（从高到低）：
  1) 真实环境变量（非空）
  2) 仓库根 .env
  3) deploy.local.env（由 DEPLOY_ENV_FILE 覆盖或默认 scripts/deploy.local.env）
  4) 本文件内的非敏感占位默认 (127.0.0.1 / 22 / root / ~/.ssh/id_ed25519 / example.com)

支持标准名与旧别名：
  - DEPLOY_DOMAIN 与 DEPLOY_SITE_DOMAIN
  - DEPLOY_KEY 与 DEPLOY_SSH_KEY

铁律：
  - 真实主机 / 端口 / 私钥 / 域名**只**存在于本地 `.env`、`deploy.local.env` 或环境变量；
    受控源码与文档一律使用占位符，**禁止把真实值写回本文件或任何受控文件**。
  - 解析器不做任何转义（Windows 路径里的反斜杠原样保留），不引入新依赖。
  - `DEPLOY_SSH_KEY_PEM`（私钥内容注入）由 `deploy_dist.py` 自行处理。
  - 配置项的完整清单与说明以 `site/config/schema.ts` 为准（`npm run doctor` 可查看）。

用法：
    from deploy_config import DEPLOY_HOST, DEPLOY_PORT, ssh_connect, webroot
"""
from __future__ import annotations

import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)

#: 配置文件路径（可被 DEPLOY_ENV_FILE 覆盖）
ENV_FILE = os.environ.get("DEPLOY_ENV_FILE") or os.path.join(_HERE, "deploy.local.env")

_CACHE = None
_DOTENV_CACHE = None


def _parse_key_value(path):
    data = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip().lstrip("\ufeff")
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                for q in ('"', "'"):
                    if len(val) >= 2 and val.startswith(q) and val.endswith(q):
                        val = val[1:-1]
                if key:
                    data[key] = val
    except OSError:
        data = {}
    return data


def read_env_file(path=None):
    """解析 `KEY=VALUE` 文本；忽略空行/`#` 注释，去成对引号，不做转义。"""
    global _CACHE
    target_path = path or os.environ.get("DEPLOY_ENV_FILE") or ENV_FILE
    cached = _CACHE is not None and path is None and target_path == (os.environ.get("DEPLOY_ENV_FILE") or ENV_FILE)
    if cached:
        return _CACHE
    data = _parse_key_value(target_path)
    if path is None:
        _CACHE = data
    return data


def _read_repo_dotenv():
    global _DOTENV_CACHE
    if _DOTENV_CACHE is not None:
        return _DOTENV_CACHE
    dotenv_path = os.path.join(_REPO_ROOT, ".env")
    _DOTENV_CACHE = _parse_key_value(dotenv_path)
    return _DOTENV_CACHE


def get(name, default=None):
    """取一项配置：环境变量（非空） > 仓库根 .env > deploy.local.env > default。

    兼容 DEPLOY_DOMAIN / DEPLOY_SITE_DOMAIN 以及 DEPLOY_KEY / DEPLOY_SSH_KEY。
    """
    if name == "DEPLOY_DOMAIN":
        keys_to_try = ["DEPLOY_DOMAIN", "DEPLOY_SITE_DOMAIN"]
    elif name == "DEPLOY_KEY":
        keys_to_try = ["DEPLOY_KEY", "DEPLOY_SSH_KEY"]
    else:
        keys_to_try = [name]

    # 1. 真实环境变量
    for k in keys_to_try:
        val = (os.environ.get(k) or "").strip()
        if val:
            return val

    # 2. 仓库根 .env
    dotenv_data = _read_repo_dotenv()
    for k in keys_to_try:
        val = (dotenv_data.get(k) or "").strip()
        if val:
            return val

    # 3. deploy.local.env
    local_data = read_env_file()
    for k in keys_to_try:
        val = (local_data.get(k) or "").strip()
        if val:
            return val

    return default


def _port():
    raw = get("DEPLOY_PORT", "22")
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise SystemExit(
            "[deploy_config] DEPLOY_PORT 必须是整数：当前值无法解析。"
            "检查环境变量 DEPLOY_PORT 或 %s" % ENV_FILE
        )


#: 目标主机（占位默认 127.0.0.1）
DEPLOY_HOST = get("DEPLOY_HOST", "127.0.0.1")
#: SSH 端口（占位默认 22）
DEPLOY_PORT = _port()
#: SSH 用户（占位默认 root）
DEPLOY_USER = get("DEPLOY_USER", "root")
#: 私钥路径（`DEPLOY_KEY` 为主名，`DEPLOY_SSH_KEY` 仍兼容）
DEPLOY_KEY = os.path.expanduser(
    get("DEPLOY_KEY") or get("DEPLOY_SSH_KEY") or "~/.ssh/id_ed25519"
)
#: 远端站点根目录（占位默认 /var/www/example.com）
DEPLOY_WEBROOT = get("DEPLOY_WEBROOT", "/var/www/example.com").rstrip("/")
#: 站点主域名（占位默认 example.com）
DEPLOY_DOMAIN = get("DEPLOY_DOMAIN", "example.com")
#: 认证子域（占位默认 auth.example.com）
DEPLOY_AUTH_DOMAIN = get("DEPLOY_AUTH_DOMAIN", "auth.example.com")


def webroot(*parts):
    """拼远端路径：`webroot("assets", "x.js")` -> `<webroot>/assets/x.js`。"""
    tail = "/".join(str(p).strip("/") for p in parts if str(p).strip("/"))
    return DEPLOY_WEBROOT + ("/" + tail if tail else "")


def site_url(path=""):
    """站点 URL：`site_url("/g01/")` -> `https://<DEPLOY_DOMAIN>/g01/`。"""
    return "https://%s/%s" % (DEPLOY_DOMAIN, str(path).lstrip("/"))


def nginx_conf(domain=None):
    """nginx 站点配置文件路径。"""
    return "/etc/nginx/sites-available/%s" % (domain or DEPLOY_DOMAIN)


def ssh_connect(timeout=25):
    """建立 paramiko 连接（惰性导入，严格校验 known_hosts 指纹，防范中间人攻击）。"""
    try:
        import paramiko  # noqa: PLC0415
    except ImportError:
        raise SystemExit(
            "缺少 paramiko：pip install paramiko（或 python -m pip install --user paramiko）"
        )
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    user_kh = os.path.expanduser("~/.ssh/known_hosts")
    if os.path.exists(user_kh):
        client.load_host_keys(user_kh)
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(
            DEPLOY_HOST, DEPLOY_PORT, username=DEPLOY_USER, key_filename=DEPLOY_KEY, timeout=timeout
        )
    except Exception as e:
        msg = str(e)
        if (
            "Server not found in known_hosts" in msg
            or "not found in known_hosts" in msg
            or "BadHostKeyException" in type(e).__name__
        ):
            raise SystemExit(
                "[X] SSH 主机指纹验证失败 (Host key verification failed for %s:%s):\n"
                "    目标主机未在 ~/.ssh/known_hosts 中收录，或主机密钥已变更。\n"
                "    为避免中间人攻击风险，请在终端执行以下命令将该主机公钥信任收录后重试：\n"
                "      ssh-keyscan -p %s %s >> ~/.ssh/known_hosts\n"
                "    错误详情: %s" % (DEPLOY_HOST, DEPLOY_PORT, DEPLOY_PORT, DEPLOY_HOST, e)
            )
        raise
    return client


def mask(value):
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


def describe():
    """一行掩码摘要（供日志打印，本身不含明文）。"""
    return "user=%s host=%s port=%s key=%s webroot=%s domain=%s" % (
        DEPLOY_USER,
        mask(DEPLOY_HOST),
        DEPLOY_PORT,
        mask(DEPLOY_KEY),
        DEPLOY_WEBROOT,
        DEPLOY_DOMAIN,
    )
