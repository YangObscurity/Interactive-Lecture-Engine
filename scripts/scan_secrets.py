# -*- coding: utf-8 -*-
"""scan_secrets.py — 密钥与隐私扫描闸门（CI 可用，可重复运行）

定位
----
本仓库是「引擎开源、讲义私有」的形态：工作区有 8000+ 文件，
但 `git ls-files` 只有 150 个 tracked 文件 —— **只有 tracked 文件会随开源发布**。
因此本脚本默认只扫 tracked 文件（= 真正决定开源是否泄密的范围），
用 `--include-untracked` 才扫描全树（用于评估「误提交风险面」）。

设计要点
--------
1. **规则集中**：全部正则集中在文件顶部的 `RULES` 一张表里，便于维护与评审。
2. **白名单是规则，不是硬编码例外**：见 `WHITELIST_RULES`，每条都有明确理由
   （RFC 2606 教学域名、占位符形态、说明性注释等），而不是逐个文件路径豁免。
3. **路径从 `__file__` 推导**（AGENTS.md §6.3），严禁硬编码绝对路径。
4. **结论反映到退出码**（AGENTS.md §6.3）：
     0 = 干净；1 = 有发现；2 = 闸门自身错误（如不在 git 仓库内 / 扫描集为空）。
5. **真空防护**（AGENTS.md §0.1）：扫描集为空时**报错退出**，绝不报 PASS。
6. **不回显疑似凭据正文**：命中原文一律脱敏为「前 6 位 + ... + 总长度」，
   避免审计报告本身成为新的泄露源。

用法
----
    python scripts/scan_secrets.py                  # 只扫 tracked 文件（默认）
    python scripts/scan_secrets.py --include-untracked   # 扫全树
    python scripts/scan_secrets.py --list-rules     # 打印规则表
    python scripts/scan_secrets.py --json out.json  # 额外输出 JSON 报告
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys

# ── 跨平台 stdout 编码：Windows 控制台默认 GBK，直接 print emoji 会 UnicodeEncodeError。
#    这里强制 UTF-8 并用 errors="replace" 兜底，保证 CI（Linux）与开发机（Windows）行为一致。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

# ─────────────────────────────────────────────────────────────────────────────
# §1 规则表（唯一真源，按类别分组，便于维护）
#    每项： (类别键, 类别中文名, 风险等级, 正则, 说明)
#    ★ 正则里的「命中组」约定：优先取 group(1)（若存在）作为待脱敏的敏感值，
#      否则取整个匹配。这样可以把「key = value」里的 value 单独摘出来。
# ─────────────────────────────────────────────────────────────────────────────
RULES: list[tuple[str, str, str, str, str]] = [
    # ── 1. 凭据 ──────────────────────────────────────────────────────────
    ("cred.notion", "Notion 令牌", "high",
     r"\b(ntn_[A-Za-z0-9]{8,}|secret_[A-Za-z0-9]{20,})\b",
     "Notion internal integration token 真实形态"),
    ("cred.privkey", "私钥内容", "high",
     r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
     "PEM 私钥块，绝不可入库"),
    ("cred.assign", "凭据赋值", "high",
     r"""(?ix)\b(api[_-]?key|apikey|secret|passwd|password|bearer|
                  auth[_-]?token|access[_-]?token|client[_-]?secret)\b
                 \s*[:=]\s*["']?([^\s"'#]{8,})""",
     "看起来像真实取值的凭据赋值（占位符由白名单放行）"),
    ("cred.github_pat", "GitHub 令牌", "high",
     r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
     "GitHub PAT / OAuth token"),
    ("cred.cloud_key", "云厂商 AccessKey", "high",
     r"\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,})\b",
     "AWS AccessKey ID / Google API key"),
    ("cred.openai", "OpenAI 风格密钥", "high",
     r"\bsk-[A-Za-z0-9]{20,}\b",
     "sk- 前缀的长密钥"),
    ("cred.jwt", "JWT", "high",
     r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b",
     "完整三段式 JWT"),
    ("cred.ssh_target", "SSH 目标", "high",
     r"(?i)\bssh\s+[a-z0-9_.\-]+@[a-z0-9.\-]+|\b[a-z0-9_.\-]+@\d{1,3}(?:\.\d{1,3}){3}\b",
     "ssh 目标或 user@IPv4"),

    # ── 2. 身份信息 ──────────────────────────────────────────────────────
    ("id.email", "邮箱", "medium",
     r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
     "真实邮箱属个人信息；example.com 等教学域名由白名单放行"),
    ("id.phone_cn", "中国大陆手机号", "high",
     r"(?<![0-9])1[3-9][0-9]{9}(?![0-9])",
     "11 位手机号"),
    ("id.wechat", "微信号 / wxid", "high",
     r"\bwxid_[A-Za-z0-9_\-]{6,}\b",
     "微信内部 ID"),
    # ── 3. 网络资产 ──────────────────────────────────────────────────────
    ("net.ip_public", "公网 IP", "high",
     r"(?<![\d.])(?!127\.0\.0\.1)(?!0\.0\.0\.0)"
     r"(?!10\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)"
     r"(?:\d{1,3}\.){3}\d{1,3}(?![\d.])",
     "非私有网段的 IPv4（真实服务器地址）"),
    ("net.ip_private", "私有网段 IP", "low",
     r"(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
     r"|192\.168\.\d{1,3}\.\d{1,3}"
     r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])",
     "内网地址：暴露内网拓扑，多为文档示例（低危）"),
    ("net.shady_port", "非常规端口", "low",
     r":(?:2[0-9]{3}|3[0-9]{3}|[4-9][0-9]{3})\b",
     "非标准端口，可能是私人服务端口"),

    # ── 4. 私人数据 ──────────────────────────────────────────────────────
    ("data.uuid", "UUID / Notion 页面 ID", "high",
     r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
     "Notion 页面/数据库 ID 属私人数据（SVG 内部 id 由白名单放行）"),
    ("data.hex32", "32 位十六进制 ID", "medium",
     r"\b[0-9a-fA-F]{32}\b",
     "无连字符的 Notion/云资源 ID"),
    ("data.b64", "长 Base64 串", "medium",
     r"\b[A-Za-z0-9+/]{60,}={0,2}\b",
     "疑似 base64 编码的凭据/密钥"),

    # ── 5. 绝对路径与用户目录 ────────────────────────────────────────────
    ("path.windows", "Windows 绝对路径", "medium",
     r"\b[A-Za-z]:[\\/](?:[^\\/\s\"'`|<>:*?]+[\\/])*[^\\/\s\"'`|<>:*?]*",
     "暴露特定机器目录布局或用户名"),
    ("path.unix_home", "Unix 家目录路径", "medium",
     r"/(?:Users|home)/[A-Za-z0-9._\-]+",
     "暴露特定机器用户名；通用占位路径由白名单放行"),
    ("path.win_user", "Windows 用户目录", "high",
     r"(?i)[A-Za-z]:[\\/]Users[\\/][^\\/\s\"'`]+",
     "包含特定用户名的 Windows 绝对路径"),

    # ── 6. 业务讲义标识 ──────────────────────────────────────────────────
    ("biz.lecture_id", "讲义编号 Gxx-Lxx", "low",
     r"\bG\d{2}-L\d{2}\b",
     "讲义编号本身是结构标识；若与课程体系描述同现则提示关注"),

    # ── 7. 云资源标识 ────────────────────────────────────────────────────
    ("cloud.arn", "AWS ARN / account", "high",
     r"\barn:aws:[a-z0-9\-]+:[a-z0-9\-]*:\d{12}:|(?<!\d)\d{12}(?!\d)",
     "AWS ARN 或 12 位账号 ID"),
    ("cloud.cognito", "Cognito / Firebase", "high",
     r"\b(?:[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{6,}|[a-z0-9\-]+\.firebaseio\.com"
     r"|[a-z0-9\-]+\.amazonaws\.com/)[A-Za-z0-9_\-./]*",
     "Cognito pool id / Firebase / AWS 端点"),

    # ── 8. 隐藏凭据 ──────────────────────────────────────────────────────
    ("hidden.env", ".env 真实赋值", "high",
     # 只看「密钥类变量名 = 值」，且值必须像真实密钥：含数字或大小写混合，
     # 以此排除 `bool(...)`、`collections.Counter()` 这类**代码表达式**误报。
     r"""(?im)^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*"""
     r"""(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|SSH_KEY_PEM|CREDENTIAL)"""
     r"""[A-Z0-9_]*[ \t]*=[ \t]*([A-Za-z0-9_\-/+.]{12,})[ \t]*$""",
     ".env / 脚本里的密钥类变量被赋值（占位符由白名单放行）"),
    ("hidden.hardcoded", "硬编码的\"临时\"凭据", "high",
     r"(?i)\b(?:hardcod\w*|临时|temporar\w*|硬编码)\b[^\n]{0,40}?"
     r"(?:token|secret|password|key|凭据|密钥)[^\n]{0,20}[:=]?\s*([A-Za-z0-9_\-]{16,})",
     "注释里自称临时/硬编码的凭据"),
]

# 二进制/非文本扩展名：跳过逐行正则（改由图片元数据专用检查处理）
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
    ".zip", ".gz", ".woff", ".woff2", ".ttf", ".eot",
}

# ─────────────────────────────────────────────────────────────────────────────
# §2 白名单规则（必须有明确理由，禁止无理由地按文件路径整体豁免）
#
#    每条 = (说明, 命中文本判定函数)。判定函数收到 (line, matched_text)，
#    返回 True 表示「这是良性占位符 / 教学示例」，应当放行。
# ─────────────────────────────────────────────────────────────────────────────

# RFC 2606 / RFC 6761 保留的文档与教学域名 —— 永不对应真实主机
RESERVED_HOSTS = (
    "example.com", "example.org", "example.net",
    "example.edu", "example.io", "example.dev", "example.test",
    "test.example", "invalid", "localhost", "127.0.0.1", "docs.example.com",
    "auth.example.com", "0.0.0.0",
)

# 明确的占位符形态（全 x / 全 0 / 全 * / 尖括号 / 花括号）
PLACEHOLDER_RE = re.compile(
    r"""^(?:
        [xX*]+                          # xxxxxxxx
      | 0+ | [0a-fA-F\-]*0[Aa0\-]*      # 0000-0000 / 全零 UUID
      | <[^>]*>                          # <你的用户名>
      | \{\{[^}]*\}\}                    # {{ value }}
      | \.\.\. | …                       # 省略号占位
    )$""",
    re.VERBOSE,
)

# 说明性语境关键词：文档在讲「曾经硬编码过」「绝不要把真实值写回」时，
# 句中出现的 token/key 等词是**叙述**而非凭据。这是白名单的核心规则之一。
NARRATIVE_MARKERS = (
    "历史", "原先", "原为", "曾是", "曾经", "不再", "绝不", "严禁", "禁止",
    "不要把", "勿写", "写回", "占位", "示例", "例如", "如 `", "术语",
    "硬编码过", "已清", "清除", "脱敏", "泄露过", "吊销",
    "历史上", "开源改造", "原先是", "改为", "回退到", "不提供任何默认值",
    "变量名", "字段名", "形如", "前缀", "命名", "文档", "注释",
)

# 常见英文叙述词（说明性注释）
NARRATIVE_EN = (
    "placeholder", "example", "sample", "dummy", "fake", "mock",
    "never", "must not", "do not", "instead of", "formerly", "previously",
    "hardcod", "removed", "sanitiz", "redact",
)

# 技术性 UUID：SVG 的 id / data-v-* 属性、gradient 引用等，与个人数据无关
TECHNICAL_UUID_CONTEXT = (
    'data-v-', 'id="', "id='", "url(#", 'xmlns', 'gradient', '<svg',
    '<path', '<g ', 'transform=', 'fill=', 'clip-',
)

# 通用软件安装路径：标准系统安装路径，跨机器同构（Chrome/Node/Edge 等）
GENERIC_SOFTWARE_PATHS = (
    r"c:\program files", r"c:\program files (x86)",
    r"c:\windows", r"c:\nodejs", r"h:\nodejs", r"c:\python",
    r"c:\users\<", r"c:\users\当前用户", r"c:\users\<你>",
    r"c:\users\<username>", r"/home/<u>", r"/home/user",
    r"/home/runner", r"/users/<", r"/opt/",
)

# RFC 正文里的章节编号（如 RFC 9293 §3.8.6.2）会被 IPv4 正则误判为公网 IP。
RFC_SECTION_RE = re.compile(r"(?i)\bRFC[\s\-]?\d{3,5}\b|§|\bsec(?:tion)?\s*\d")


def is_whitelisted(line: str, matched: str, rule_key: str) -> tuple[bool, str]:
    """判断某条命中是否为良性。返回 (是否放行, 理由)。"""
    low = line.lower()
    m = (matched or "").strip()

    # ── 规则 A：明确的占位符形态 ────────────────────────────────────────
    if PLACEHOLDER_RE.match(m):
        return True, "占位符形态（全 x / 全 0 / 尖括号 / 省略号）"
    # .env.example 的 ntn_xxxxxxxx... / xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    if re.fullmatch(r"ntn_[xX]+", m):
        return True, ".env.example Notion 令牌占位符"
    if re.fullmatch(r"[xX]{8}-[xX]{4}-[xX]{4}-[xX]{4}-[xX]{12}", m):
        return True, ".env.example UUID 占位符"

    # ── 规则 A2：形如 wxid_xxxxxxxx 的**文档占位符**（非真实微信 ID）──
    #     《make_site_icon.py》的 docstring 在说明「账号 ID 形如 wxid_xxx 属泄露」，
    #     这本身是安全说明，不是泄露。
    if rule_key == "id.wechat":
        if re.fullmatch(r"wxid_[xX]+", m):
            return True, "文档中的 wxid 占位符（全 x）"
        if any(mk in line for mk in NARRATIVE_MARKERS):
            return True, "说明性注释（讲述 wxid 是敏感项，非真实值）"

    # ── 规则 A3：RFC 正文章节号被 IPv4 正则误判 ────────────────────────
    if rule_key == "net.ip_public":
        if RFC_SECTION_RE.search(line):
            return True, "RFC 规范正文的章节编号，非 IP 地址"
        # 版本号形态（如 3.8.6.2）—— 四段但首段 <10 且行内无网络语境
        parts = m.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts):
            if int(parts[0]) < 10 and not any(
                    w in low for w in ("http", "https", "ssh", "ip", "host",
                                       "server", "ping", "curl", "端口", "地址")):
                return True, "版本号/章节号形态（非 IP 地址）"

    # ── 规则 B：RFC 2606 保留域名（教学/文档专用）─────────────────────
    if rule_key == "id.email":
        domain = m.rsplit("@", 1)[-1].lower()
        if domain in RESERVED_HOSTS or domain.endswith(".example") \
                or domain.endswith(".invalid") or domain.endswith(".test"):
            return True, f"RFC 2606 保留域名 {domain}（教学占位，非真实邮箱）"
        # git 的示例用户名
        if m.lower() in ("git@github.com", "user@host", "you@example.com"):
            return True, "git/教程通用示例邮箱"
        # ★ GitHub **noreply** 匿名地址：这不是"泄露"，恰恰是**正确的隐私做法** ——
        #   它由 GitHub 生成、用于在不公开真实邮箱的前提下归因提交。
        #   本仓库刻意用它作为提交身份（见 rewrite_commit_identity.py / deploy 脚本），
        #   若把它判为风险，反而会逼着维护者改回真实邮箱 —— 与隐私目标相反。
        #   形态：`<id>+<login>@users.noreply.github.com` 或 `<login>@users.noreply.github.com`
        if domain.endswith("users.noreply.github.com"):
            return True, "GitHub noreply 匿名地址（刻意的隐私做法，非真实邮箱）"

    if rule_key in ("net.ip_public", "net.ip_private", "cred.ssh_target"):
        if m in ("127.0.0.1", "0.0.0.0", "<LAN_TARGET>", "10.0.1.20",
                 "<LAN_TARGET>", "10.0.0.1"):
            # 文档里用于讲 mermaid 标签/示例的保留地址
            return True, "文档示例保留地址（RFC 5737/1918 教学用法）"

    # ── 规则 C：技术性 UUID（SVG 内部标识，非 Notion 页面 ID）─────────
    if rule_key in ("data.uuid", "data.hex32"):
        if any(ctx.lower() in low for ctx in TECHNICAL_UUID_CONTEXT):
            return True, "SVG/图形内部技术标识，与个人数据无关"
        # package-lock.json 的哈希
        if "integrity" in low or "shasum" in low or "resolved" in low:
            return True, "依赖锁文件完整性哈希"

    # ── 规则 D：说明性/叙述性注释 ───────────────────────────────────────
    #     文档在讲「这里曾经硬编码过真实值/绝不要写回」时，句子里的
    #     token/key/密码 等词是**叙述对象**，不是凭据本体。
    if rule_key in ("hidden.env", "hidden.hardcoded", "cred.assign",
                    "data.uuid", "path.windows", "path.unix_home"):
        if any(mk in line for mk in NARRATIVE_MARKERS):
            return True, "说明性注释/文档（叙述曾硬编码，非凭据本体）"
        if any(mk in low for mk in NARRATIVE_EN):
            return True, "说明性英文注释（narrative, not a credential）"

    # ── 规则 E：通用/可移植系统路径 ────────────────────────────────────
    if rule_key in ("path.unix_home", "path.windows", "path.win_user"):
        if re.fullmatch(r"/(?:Users|home)/(?:user|username|you|yourname|<[^>]+>)",
                        m) or m.lower() in ("/home/user", "/home/runner"):
            return True, "通用占位用户名（非真实用户）"
        if re.search(r"[\\/]Users[\\/]<[^>]+>|[\\/]Users[\\/]<你>", m):
            return True, "Windows 用户路径占位符"
        # 纯文档命令里的盘符占位（<REPO_ROOT>、g:\...）
        if re.fullmatch(r"[A-Za-z]:(?:[\\/]\.\.\.)?", m):
            return True, "盘符占位符（无真实路径信息）"
        if "example" in low or "<repo_root>" in low:
            return True, "文档占位域名/仓库根占位符"
        # 通用软件安装路径（标准系统安装目录，无特定机器用户名）
        ml = m.lower()
        if any(ml.startswith(p) or p in ml for p in GENERIC_SOFTWARE_PATHS):
            return True, "通用软件安装路径（标准系统目录，跨机器同构）"
        # 云主机通用目录（/opt/... 等系统路径）
        if re.match(r"^/opt/[A-Za-z0-9_\-./]*$", m):
            return True, "云主机通用系统目录（标准系统目录）"

    # ── 规则 F：私有网段的通用教学用法 ─────────────────────────────────
    if rule_key == "net.ip_private":
        if any(mk in line for mk in NARRATIVE_MARKERS + ("示例", "例如", "如 ")):
            return True, "文档示例内网地址"
        # 标准网关/回环/容器网段
        if m.endswith(".0.1") or m.endswith(".1.1"):
            return True, "常见网关地址（文档示例）"

    # ── 规则 G：端口号出现在文档/URL 示例里 ───────────────────────────
    if rule_key == "net.shady_port":
        # 只列**通用开发端口与本项目自用端口**（VitePress 的 5173/4173 等）。
        # ⚠️ 刻意不列维护者私人服务的端口 —— 即使是放在白名单里，
        #    也等于把私人基建的指纹写进开源代码（本仓库有"为说明问题而
        #    把问题本身写进产物"的事故史，此处同理）。
        if any(p in m for p in (":5173", ":4173", ":8000", ":8080", ":8090",
                                ":8081", ":3000", ":9091")):
            if any(mk in line for mk in NARRATIVE_MARKERS) or \
               any(d in low for d in ("127.0.0.1", "localhost", "example")):
                return True, "本地开发/文档示例端口"
        if "127.0.0.1" in low or "localhost" in low:
            return True, "本地回环端口（开发服务）"

    # ── 规则 H：依赖锁文件里的哈希与版本 ───────────────────────────────
    if rule_key in ("data.b64", "data.hex32"):
        if "package-lock" in low or "integrity" in low:
            return True, "依赖锁文件哈希"

    # ── 规则 I：讲义编号是结构标识，非敏感凭据 ─────────────────────────
    if rule_key == "biz.lecture_id":
        return True, "讲义编号为公开结构标识（Gxx-Lxx）"

    return False, ""


# ─────────────────────────────────────────────────────────────────────────────
# §3 采集待扫描文件
# ─────────────────────────────────────────────────────────────────────────────

def repo_root() -> pathlib.Path:
    """路径从脚本自身位置推导（AGENTS.md §6.3：严禁硬编码绝对路径）。"""
    return pathlib.Path(__file__).resolve().parents[1]


def git(REPO: pathlib.Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=REPO,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{proc.stderr.strip()}")
    return proc.stdout


def collect_files(REPO: pathlib.Path, include_untracked: bool) -> tuple[list[str], list[str]]:
    """返回 (tracked 列表, untracked 列表)。"""
    if (REPO / ".git").exists():
        try:
            tracked = [ln for ln in git(REPO, "ls-files").splitlines() if ln.strip()]
            if not include_untracked:
                return tracked, []
            others = [ln for ln in git(REPO, "ls-files", "--others", "--exclude-standard").splitlines()
                      if ln.strip()]
            return tracked, others
        except Exception:
            pass

    # 若非独立 git 仓库或 git 失败，直接扫描文件树（排除常规构建/临时目录）
    exclude_dirs = {".git", "node_modules", "dist", "cache", ".temp", "__pycache__"}
    files = []
    for p in REPO.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(REPO)
        if any(part in exclude_dirs for part in rel.parts):
            continue
        files.append(rel.as_posix())
    return files, []


# ─────────────────────────────────────────────────────────────────────────────
# §4 脱敏：绝不完整回显疑似凭据
# ─────────────────────────────────────────────────────────────────────────────

def redact(value: str) -> str:
    """仅显示前 6 位 + ... + 总长度。硬性要求：报告本身不得成为泄露源。"""
    v = value or ""
    if len(v) <= 6:
        return f"[已脱敏 · 长度 {len(v)}]"
    return f"{v[:6]}...（长度 {len(v)}）"


# ─────────────────────────────────────────────────────────────────────────────
# §5 主扫描
# ─────────────────────────────────────────────────────────────────────────────

CompiledRule = tuple[str, str, str, re.Pattern, str]


def compile_rules() -> list[CompiledRule]:
    out = []
    for key, name, level, pattern, desc in RULES:
        out.append((key, name, level, re.compile(pattern), desc))
    return out


def scan_text_file(REPO: pathlib.Path, rel: str, rules: list[CompiledRule],
                   tracked: bool) -> list[dict]:
    findings: list[dict] = []
    path = REPO / rel
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return findings
    for lineno, line in enumerate(text.splitlines(), 1):
        if len(line) > 4000:            # 超长单行（如打包 JS/SVG）只做截断匹配
            line = line[:4000]
        for key, name, level, rx, desc in rules:
            for mo in rx.finditer(line):
                # 命中组约定：优先 group(1)
                raw = mo.group(1) if (mo.groups() and mo.group(1)) else mo.group(0)
                ok, why = is_whitelisted(line, raw, key)
                if ok:
                    continue
                # 整行级白名单（叙述性语境）二次确认
                ok2, why2 = is_whitelisted(line, line.strip(), "hidden.hardcoded")
                if ok2 and key in ("cred.assign", "hidden.env"):
                    continue
                findings.append({
                    "file": rel,
                    "line": lineno,
                    "category": key,
                    "category_name": name,
                    "level": level,
                    "match_redacted": redact(raw),
                    "match_len": len(raw),
                    "rule": desc,
                    "tracked": tracked,
                    "snippet": line.strip()[:160],
                })
    return findings


def scan_image_metadata(REPO: pathlib.Path, rel: str, tracked: bool) -> list[dict]:
    """图片元数据（EXIF GPS/作者）检查。缺 PIL 时降级为字节串扫描。"""
    findings: list[dict] = []
    path = REPO / rel
    if not path.exists():
        return findings
    try:
        from PIL import Image  # type: ignore
        from PIL.ExifTags import TAGS  # type: ignore
    except ImportError:
        data = path.read_bytes()[:200000]
        for needle in (b"GPS", b"<dc:creator", b"xmp:", b"Exif\x00\x00"):
            if needle in data:
                findings.append({
                    "file": rel, "line": 0, "category": "img.metadata",
                    "category_name": "图片元数据", "level": "medium",
                    "match_redacted": redact(needle.decode("latin-1")),
                    "match_len": len(needle), "rule": "图片含元数据标记（无 PIL，降级检测）",
                    "tracked": tracked, "snippet": "(binary)",
                })
        return findings
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            if exif:
                tags = {TAGS.get(k, str(k)): str(v)[:60] for k, v in exif.items()}
                sensitive = {k: v for k, v in tags.items()
                             if any(s in k.lower() for s in
                                    ("gps", "artist", "author", "copyright", "software",
                                     "make", "model", "datetime", "owner", "comment"))}
                if sensitive:
                    findings.append({
                        "file": rel, "line": 0, "category": "img.metadata",
                        "category_name": "图片 EXIF 元数据", "level": "medium",
                        "match_redacted": redact(json.dumps(sensitive, ensure_ascii=False)),
                        "match_len": len(json.dumps(sensitive)),
                        "rule": "EXIF 含 GPS/作者/设备信息",
                        "tracked": tracked, "snippet": str(list(sensitive))[:160],
                    })
            for k, v in (im.info or {}).items():
                if k in ("icc_profile", "exif"):
                    continue
                if k.lower() in ("author", "comment", "copyright", "artist"):
                    findings.append({
                        "file": rel, "line": 0, "category": "img.metadata",
                        "category_name": "图片文本元数据", "level": "medium",
                        "match_redacted": redact(str(v)), "match_len": len(str(v)),
                        "rule": f"图片 {k} 元数据", "tracked": tracked,
                        "snippet": f"{k}={str(v)[:80]}",
                    })
    except Exception:
        pass
    return findings


LEVEL_ORDER = {"high": 0, "medium": 1, "low": 2}
LEVEL_ICON = {"high": "🔴", "medium": "🟡", "low": "🟢"}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="密钥与隐私扫描闸门（默认只扫 git tracked 文件 = 开源发布范围）")
    ap.add_argument("--include-untracked", action="store_true",
                    help="同时扫描未跟踪文件（评估误提交风险面）")
    ap.add_argument("--list-rules", action="store_true", help="打印规则表后退出")
    ap.add_argument("--json", metavar="PATH", help="额外写出 JSON 报告")
    ap.add_argument("--root", help="仓库根（默认从 __file__ 推导）")
    ap.add_argument("--strict", action="store_true",
                    help="中/低风险也判为失败（发布前逐条复核用；CI 默认不用）")
    args = ap.parse_args(argv)
    strict = args.strict

    if args.list_rules:
        print("规则表（类别 / 等级 / 说明）")
        print("─" * 78)
        for key, name, level, pat, desc in RULES:
            print(f"  {LEVEL_ICON[level]} {key:20s} {name:14s} {desc}")
        print(f"\n共 {len(RULES)} 条规则。")
        return 0

    REPO = pathlib.Path(args.root).resolve() if args.root else repo_root()
    if not REPO.exists():
        print(f"✗ 闸门错误：目标目录不存在: {REPO}")
        return 2

    try:
        tracked, untracked = collect_files(REPO, args.include_untracked)
    except RuntimeError as e:
        print(f"✗ 闸门错误：{e}")
        return 2

    scan_list = [(f, True) for f in tracked]
    if args.include_untracked:
        scan_list += [(f, False) for f in untracked]

    # ── 真空防护（AGENTS.md §0.1 / §6.3）────────────────────────────────
    if not scan_list:
        print("✗ 闸门错误：扫描集为空 —— 无法判定，绝不报 PASS。")
        return 2

    rules = compile_rules()
    findings: list[dict] = []
    for rel, tracked_flag in scan_list:
        ext = pathlib.Path(rel).suffix.lower()
        if ext in BINARY_EXT:
            findings.extend(scan_image_metadata(REPO, rel, tracked_flag))
        else:
            findings.extend(scan_text_file(REPO, rel, rules, tracked_flag))

    findings.sort(key=lambda f: (LEVEL_ORDER[f["level"]], f["category"], f["file"], f["line"]))

    mode = "tracked + untracked（全树）" if args.include_untracked else "仅 tracked（开源发布范围）"
    print("═" * 78)
    print("密钥与隐私扫描闸门 scan_secrets.py")
    print("═" * 78)
    print(f"仓库根      ：{REPO}")
    print(f"扫描模式    ：{mode}")
    print(f"tracked 文件：{len(tracked)}")
    if args.include_untracked:
        print(f"untracked   ：{len(untracked)}")
    print(f"规则条数    ：{len(rules)}")
    print(f"命中总数    ：{len(findings)}")
    print()

    if not findings:
        print("结论: PASS —— 未发现任何敏感信息。")
        return 0

    by_level: dict[str, list[dict]] = {"high": [], "medium": [], "low": []}
    for f in findings:
        by_level[f["level"]].append(f)

    print(f"按等级：🔴 高 {len(by_level['high'])} ｜ "
          f"🟡 中 {len(by_level['medium'])} ｜ 🟢 低 {len(by_level['low'])}")
    print()

    # 按类别聚合输出（避免超长刷屏）
    seen_cat: dict[str, int] = {}
    for f in findings:
        seen_cat[f["category"]] = seen_cat.get(f["category"], 0) + 1
    print("按类别统计：")
    for k, v in sorted(seen_cat.items(), key=lambda kv: -kv[1]):
        print(f"  {k:20s} {v:5d}")
    print()

    print("明细（凭据类一律脱敏，不回显正文）：")
    print("─" * 78)
    for f in findings:
        flag = "tracked" if f["tracked"] else "untracked"
        loc = f"{f['file']}:{f['line']}" if f["line"] else f["file"]
        print(f"{LEVEL_ICON[f['level']]} [{flag}] {loc}")
        print(f"    {f['category_name']}（{f['category']}）")
        print(f"    命中：{f['match_redacted']}")
        print(f"    规则：{f['rule']}")
        print()

    if args.json:
        out = pathlib.Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "repo": str(REPO), "mode": mode,
            "tracked_count": len(tracked), "findings": findings,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON 报告已写出：{out}")
        print()

    high = len(by_level["high"])
    print("═" * 78)
    if high:
        print(f"结论: FAIL —— 发现 {high} 条高风险命中，开源前必须处理。")
        return 1

    # 退出码语义（供 CI 使用）：
    #   高风险 → 1（必须修，阻断）
    #   仅中/低 → **默认 0**，但在 `--strict` 下为 1。
    #
    #   为什么默认放行中/低：它们绝大多数是**设计上就必须存在**的东西 ——
    #   `C:\Program Files\...\chrome.exe`（CDP 审计要调浏览器）、
    #   `C:\Users\<你>\.ssh\...`（文档里的占位符）、`G:\`（说明「曾污染盘根」）、
    #   以及 lock 文件里依赖作者的公开邮箱。这些无法也不该清零。
    #   若 CI 把它们判为失败，闸门必然**长期红**，团队就会开始无视它 ——
    #   那比没有闸门更糟。所以默认只让「高风险」阻断，中/低留作人工复核清单。
    #   `--strict` 供发布前逐条过一遍时使用。
    if findings:
        print(f"结论: WARN —— 无高风险，但有 {len(findings)} 条中/低风险命中待人工确认。")
        if strict:
            print("  （--strict 模式：中/低风险也判为失败）")
            return 1
        print("  （默认不阻断：中/低风险多为设计上必须存在的路径与占位符；"
              "发布前可用 --strict 逐条复核）")
        return 0
    print("结论: PASS —— 未发现任何敏感信息命中。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
