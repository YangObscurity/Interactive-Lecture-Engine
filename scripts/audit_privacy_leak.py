#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""audit_privacy_leak.py — 开源发布前隐私、凭据与防反向泄密全量拦截引擎（工业级安全门禁）。

定位与架构：
  本工具为将本地代码或特性推送到开源/公共仓库（如 interactive-lecture-engine 或 GitHub）
  提供全方位、工业级安全防御网。针对近期发生的“内部负向清单约束文件误入开源库导致反向泄密”真实事故，
  设立最严苛的五层深度穿透防御：

  Layer 1: 路径与敏感文件黑名单（含 *CONTRACT*.md 内部约束文档拦截，防反向泄密）
  Layer 2: 工业级高熵密钥与 Token 拦截（Notion Token, 私钥, 数据库连接, GitHub PAT 等）
  Layer 3: 个人身份(PII)与开发机环境指纹拦截（Windows 用户路径、LEARNING 盘符、服务器真实 IP、域名等）
  Layer 4: 私有课程体系、业务架构与代号去耦合断言（全栈物联网、SRX、DigitalThinking、私人进度统计等）
  Layer 5: Git 提交历史穿透审计与 .gitignore 规则完整性（防历史残留、防过度排除导致演示图表缺失、防主观中文注释）

退出码契约：
  0 = 全部通过 (PASS: 干净无泄露，可安全发布/提交)
  1 = 发现高危阻断项 (BLOCKED: 严禁向公开仓库推送或合并)
  2 = 执行异常或真空防护失败 (VACUUM / INVALID ARGS: 扫描集为空或参数不合法)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

# 跨平台控制台编码防护
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ==============================================================================
# §1 规则库 (Security Rules Matrix)
# ==============================================================================

# 1.1 路径与敏感文件黑名单 (Layer 1)
# 格式: (regex, rule_id, description)
FORBIDDEN_PATH_PATTERNS: List[Tuple[str, str, str]] = [
    # ── 防负向清单反向泄密铁律：禁止任何内部约束契约文件入库 ──
    (r"(?i)(?:^|[\\/]).*contract.*\.md$", "FORBIDDEN_CONTRACT_FILE", "禁止包含内部私有约束与负向清单文件（防止反向泄密，禁止 OSS_CHECK_CONTRACT.md、OSS_BUFFER_CONTRACT.md、*CONTRACT*.md 等）"),
    # ── 真实凭据与私钥文件 ──
    (r"(?:^|[\\/])\.env(?:\.local|\.production|\.development)?$", "ENV_FILE", "禁止包含真实 .env 文件（仅允许 .env.example）"),
    (r"(?:^|[\\/])id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$", "SSH_KEY_FILE", "禁止包含 SSH 私钥/公钥文件"),
    (r"\.pem$", "PEM_KEY_FILE", "禁止包含 PEM 私钥或证书文件"),
    (r"\.key$", "KEY_FILE", "禁止包含 KEY 私钥文件"),
    (r"notion_credentials\.py$", "NOTION_CRED_FILE", "禁止包含本地 Notion 真实凭据文件"),
    (r"remote_credentials\.py$", "REMOTE_CRED_FILE", "禁止包含远程服务器凭据文件"),
    (r"\.secret-patterns$", "SECRET_PATTERN_FILE", "禁止包含私有敏感词真身（仅允许 .secret-patterns.example）"),
    (r"notion_knowledge_graph\.json$", "KNOWLEDGE_GRAPH_FILE", "禁止包含个人全量知识图谱"),
    # ── 本地开发与工作区私有目录 ──
    (r"(?:^|[\\/])backups[\\/]", "BACKUP_DIR", "禁止包含历史备份目录"),
    (r"(?:^|[\\/])workspaces[\\/]", "WORKSPACE_DIR", "禁止包含私有开发工作区目录"),
    (r"(?:^|[\\/])project-memory[\\/]", "PROJECT_MEMORY_DIR", "禁止包含私有项目记忆库目录"),
    (r"\.bak\.\d+", "DIRTY_BAK_FILE", "禁止包含临时备份残留文件"),
    (r"transcript(?:_full)?\.jsonl$", "TRANSCRIPT_FILE", "禁止包含开发会话轨迹记录文件"),
]

# 1.2 高熵密钥与凭据规则 (Layer 2)
# 格式: (rule_id, category, severity, regex, description)
SECRET_RULES: List[Tuple[str, str, str, str, str]] = [
    ("cred.notion", "SECRET_LEAK", "CRITICAL",
     r"\b(ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{20,})\b",
     "真实 Notion internal integration token"),
    ("cred.privkey", "SECRET_LEAK", "CRITICAL",
     r"-----BEGIN (?:RSA|OPENSSH|DSA|EC|PGP)?\s*PRIVATE KEY-----",
     "明文 PEM / OpenSSH / RSA 私钥块"),
    ("cred.neon_db", "SECRET_LEAK", "CRITICAL",
     r"postgres(?:ql)?:\/\/[a-zA-Z0-9_\-\.]+:[^@\s'\"<>]+@[a-zA-Z0-9_\-\.]+\.[a-zA-Z]{2,}(?::\d+)?\/[a-zA-Z0-9_\-]+",
     "包含真实密码的 PostgreSQL / Neon 数据库连接串"),
    ("cred.dify", "SECRET_LEAK", "CRITICAL",
     r"\bapp-[A-Za-z0-9]{24,48}\b",
     "Dify API Key 特征"),
    ("cred.github_pat", "SECRET_LEAK", "CRITICAL",
     r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b",
     "GitHub Personal Access Token / OAuth token"),
    ("cred.generic_assign", "SECRET_LEAK", "CRITICAL",
     r"""(?ix)\b(api[_-]?key|apikey|secret|passwd|password|bearer|auth[_-]?token|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?([A-Za-z0-9_\-+/]{16,})["']?""",
     "硬编码的敏感凭据赋值语句"),
    ("cred.cloud_key", "SECRET_LEAK", "CRITICAL",
     r"\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,})\b",
     "AWS AccessKey ID / Google Cloud API Key"),
    ("cred.openai", "SECRET_LEAK", "CRITICAL",
     r"\bsk-[A-Za-z0-9]{20,}\b",
     "OpenAI 风格 API 密钥"),
    ("cred.jwt", "SECRET_LEAK", "HIGH",
     r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b",
     "完整三段式 JWT Token"),
    ("cred.ssh_target", "SECRET_LEAK", "HIGH",
     r"(?i)\bssh\s+[a-z0-9_.\-]+@[a-z0-9.\-]+|\b[a-z0-9_.\-]+@\d{1,3}(?:\.\d{1,3}){3}\b",
     "包含内网或生产用户名的 SSH 连接目标"),
]

# 1.3 个人身份与开发环境指纹 (Layer 3)
PII_RULES: List[Tuple[str, str, str, str, str]] = [
    ("LOCAL_WINDOWS_USER_PATH", "PRIVACY_LEAK", "HIGH",
     r"(?i)[A-Za-z]:[\\/]Users[\\/](?!Public(?=[\\/\"\'\`\s\.\,\;\|\)\:]|$))(?:[a-zA-Z0-9_ .\-\u4e00-\u9fa5]+(?=[\\/\"\'\`\s\,\;\|\)\:]|$)|[^\s\"\'\`<>]+)",
     "隐私警告：包含作者本地 Windows 用户绝对路径（如 C:\\Users\\...），需改用跨平台相对推导或环境变量"),
    ("LOCAL_DEV_WORKSPACE_DRIVE", "PRIVACY_LEAK", "HIGH",
     r"(?i)[A-Za-z]:[\\/]LEARNING(?=[\\/\"\'\`\s\.\,\;\|\)\:]|$)",
     "环境泄漏：包含作者本地专属开发盘符绝对路径（如 G:\\LEARNING...），需升级为通用相对路径"),
    ("pii.unix_home", "PRIVACY_LEAK", "HIGH",
     r"/(?:Users|home)/[a-zA-Z0-9_\-]+(?=[\\/\"\'\`\s\.\,\;\|\)\:]|$)",
     "包含开发机用户名的 Unix 家目录路径"),
    ("PRIVATE_SERVER_IP", "PRIVACY_LEAK", "CRITICAL",
     r"\b115\.126\.50\.101(?::\d+)?\b",
     "高危：生产服务器真实公网 IP 地址"),
    ("PRIVATE_PRODUCTION_DOMAIN", "PRIVACY_LEAK", "HIGH",
     r"(?:docs|auth)\.sanrenxing\.win",
     "生产部署私有业务域名（开源版应外置或使用 example 占位）"),
    ("pii.phone_cn", "PRIVACY_LEAK", "HIGH",
     r"(?<![0-9])1[3-9][0-9]{9}(?![0-9])",
     "中国大陆 11 位手机号"),
    ("pii.wechat", "PRIVACY_LEAK", "HIGH",
     r"\bwxid_[A-Za-z0-9_\-]{6,}\b",
     "微信内部 ID (wxid)"),
]

# 1.4 私有课程体系、业务架构与代号 (Layer 4 - 防反向泄密重点规则)
DOMAIN_RULES: List[Tuple[str, str, str, str, str]] = [
    ("domain.curriculum_name", "DOMAIN_LEAK", "HIGH",
     r"(?i)(?:全栈物联网|嵌入式与物联网|\bSRX\b|DigitalThinking)",
     "私有课程体系与业务架构代号（全栈物联网、嵌入式与物联网、SRX、DigitalThinking 等，开源版严禁包含）"),
    ("domain.lecture_title", "DOMAIN_LEAK", "HIGH",
     r"(?:C\s*语言与嵌入式编程|基础电学与硬件设计|ESP-IDF\s*固件开发)",
     "私有课程专有大纲与业务标题"),
    ("domain.private_repo", "DOMAIN_LEAK", "HIGH",
     r"(?i)YangObscurity/Tutorial(?:\.git|\b|-[A-Za-z0-9_-]+)?",
     "私有课程仓库完整标识符（如 YangObscurity/Tutorial...）"),
    ("domain.learning_stats", "DOMAIN_LEAK", "HIGH",
     r"(?i)(?:289\s*节点|279\s*节点|已完成\s*[0-9]+|学习中\s*[0-9]+|马来语节点|\b132\s*讲\b|\b438\s*张图\b)",
     "私人学习进度、统计数字与私有节点明细（如 289 节点、132 讲、438 张图等）"),
    ("domain.internal_node_id", "DOMAIN_LEAK", "HIGH",
     r"\b(?:interface_uart_i2c_spi_schematic|ee_component_intuition|ee_dc_ac_behavior)\b",
     "私有业务真实知识点标识符"),
    ("domain.project_code", "DOMAIN_LEAK", "HIGH",
     r"\bcp[0-9]{3}\b",
     "私有任务与交付项目代号 (cpXXX)"),
]

# 1.5 Layer 5: Git 历史穿透与 .gitignore 完整性检查特征
FORBIDDEN_HISTORY_PATTERNS = [
    "*CONTRACT*.md",
    "*CHECK*.md",
    "*BUFFER*.md",
    "OSS_*.md",
    "*credentials*.py",
    "notion_credentials.py",
]

GITIGNORE_SENSITIVE_COMMENT_TERMS = [
    "自用",
    "作者私有",
    "私有指纹",
    "防反向泄密",
    "私有讲义",
    "真实业务",
]

# 排除扫描的系统与外部目录
EXCLUDE_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "cache",
    ".temp",
    "__pycache__",
    ".idea",
    ".vscode",
}

# 排除扫描的文件（自检或安全示例）
EXCLUDE_FILES = {
    "audit_privacy_leak.py",
    "scan_secrets.py",
    ".secret-patterns.example",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}

# 二进制/媒体扩展名
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
    ".zip", ".gz", ".woff", ".woff2", ".ttf", ".eot", ".bin",
    ".exe", ".tar", ".svg",
}

# ─────────────────────────────────────────────────────────────────────────────
# §2 白名单与良性语境判定 (Benign Detection & RFC Standards)
# ─────────────────────────────────────────────────────────────────────────────

RESERVED_HOSTS = (
    "example.com", "example.org", "example.net",
    "example.edu", "example.io", "example.dev", "example.test",
    "test.example", "invalid", "localhost", "127.0.0.1", "docs.example.com",
    "auth.example.com", "0.0.0.0",
)

PLACEHOLDER_RE = re.compile(
    r"""^(?:
        [xX*]+                          # xxxxxxxx / ****
      | 0+ | [0a-fA-F\-]*0[Aa0\-]*      # 0000-0000 / 全零 UUID
      | <[^>]*>                          # <你的用户名> / <token>
      | \{\{[^}]*\}\}                    # {{ value }}
      | \.\.\. | …                       # 省略号占位
      | ntn_[xX]+                        # ntn_xxxxxx placeholder in .env.example
      | secret_[xX]+                     # secret_xxxx placeholder
      | ntn_your_[a-z0-9_]+              # ntn_your_notion_token
      | secret_your_[a-z0-9_]+           # secret_your_token
      | your_[a-z0-9_]+                  # your_api_key
      | my_[a-z0-9_]+                    # my_secret_token
    )$""",
    re.VERBOSE | re.IGNORECASE,
)

GENERIC_SYSTEM_PATHS = (
    r"c:\program files", r"c:\program files (x86)",
    r"c:\windows", r"c:\nodejs", r"c:\python",
    r"/home/runner", r"/home/user", r"/opt/",
)

NARRATIVE_MARKERS = (
    "历史", "原先", "原为", "曾是", "曾经", "不再", "绝不", "严禁", "禁止",
    "不要把", "勿写", "写回", "占位", "示例", "例如", "如 `", "术语",
    "硬编码过", "已清", "清除", "脱敏", "泄露过", "吊销", "防线",
    "历史上", "开源改造", "原先是", "改为", "回退到", "不提供任何默认值",
    "变量名", "字段名", "形如", "前缀", "命名", "文档", "注释", "判据", "规范",
)

NARRATIVE_EN = (
    "placeholder", "example", "sample", "dummy", "fake", "mock",
    "never", "must not", "do not", "instead of", "formerly", "previously",
    "hardcod", "removed", "sanitiz", "redact",
)


class LeakFinding:
    def __init__(
        self,
        category: str,
        rule_id: str,
        file_path: str,
        line_num: int,
        match_text: str,
        message: str,
        severity: str = "HIGH",
    ):
        self.category = category
        self.rule_id = rule_id
        self.file_path = file_path
        self.line_num = line_num
        self.match_text = match_text.strip()
        self.message = message
        self.severity = severity  # "CRITICAL", "HIGH", "MEDIUM", "LOW"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "rule_id": self.rule_id,
            "file": self.file_path,
            "line": self.line_num,
            "snippet": self.mask(self.match_text),
            "message": self.message,
            "severity": self.severity,
        }

    @staticmethod
    def mask(text: str) -> str:
        """对命中文本做部分掩码脱敏，防止审计报告本身成为泄密源。"""
        if len(text) <= 8:
            return "***"
        return text[:4] + "*" * (len(text) - 8) + text[-4:]


def is_benign(line: str, matched: str, rel_path: str = "", rule_id: str = "") -> bool:
    """判定是否为良性占位符、排除声明或说明性叙述。

    ★ 注意：绝不在白名单中豁免任何 *CONTRACT*.md 文件（防反向泄密核心规约）！
    """
    low_line = line.lower()
    low_matched = (matched or "").lower()

    # 1. 占位符匹配
    if PLACEHOLDER_RE.match(matched.strip()):
        return True

    # 2. 通用系统安装/CI 路径（/home/runner, C:\Program Files 等）
    if any(sp in low_matched for sp in GENERIC_SYSTEM_PATHS):
        return True

    # 3. 保留教学域名与测试 IP
    for h in RESERVED_HOSTS:
        if h in matched:
            return True

    # 4. 说明性历史叙述（中英文）
    if any(m in line for m in NARRATIVE_MARKERS):
        return True
    if any(en in low_line for en in NARRATIVE_EN):
        return True

    # 5. 文档排除规则声明（如在 .gitignore 中说明某些私有目录不入库）
    if ".gitignore" in line or "不随仓库发布" in line or "不入库" in line or "永不入库" in line:
        return True

    return False


def is_binary_file(p: pathlib.Path) -> bool:
    if p.suffix.lower() in BINARY_EXTENSIONS:
        return True
    try:
        with open(p, "rb") as f:
            chunk = f.read(1024)
            if b"\x00" in chunk:
                return True
    except Exception:
        return True
    return False


def get_scan_files(target_dir: pathlib.Path, include_untracked: bool = False) -> List[pathlib.Path]:
    """获取待扫描文件集合（支持 git ls-files 纯发布态与全目录扫描）。"""
    target_dir = target_dir.resolve()
    is_git_repo = (target_dir / ".git").is_dir()

    if is_git_repo and not include_untracked:
        try:
            cmd = ["git", "-C", str(target_dir), "ls-files"]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
            files = []
            for line in proc.stdout.splitlines():
                if not line.strip():
                    continue
                p = target_dir / line.strip()
                if p.name in EXCLUDE_FILES:
                    continue
                if p.is_file():
                    files.append(p)
            return files
        except Exception:
            pass  # 回退到目录遍历

    # 目录遍历
    files = []
    for root, dirs, fnames in os.walk(target_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fname in fnames:
            if fname in EXCLUDE_FILES:
                continue
            p = pathlib.Path(root) / fname
            files.append(p)
    return files


def audit_git_history(target_dir: pathlib.Path) -> List[LeakFinding]:
    """穿透检查 Git 提交历史，断言历史提交记录中不存在残留的敏感文件或内部约束文档。"""
    findings: List[LeakFinding] = []
    target_dir = target_dir.resolve()
    if not (target_dir / ".git").is_dir():
        return findings

    try:
        cmd = [
            "git", "-C", str(target_dir), "log", "--all", "--full-history",
            "--name-status", "--format=commit %h %s", "--",
            *FORBIDDEN_HISTORY_PATTERNS,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
            current_commit = "unknown"
            for line in lines:
                if line.startswith("commit "):
                    current_commit = line
                else:
                    parts = line.split(None, 1)
                    status = parts[0] if len(parts) > 0 else ""
                    filename = parts[1] if len(parts) > 1 else line
                    findings.append(LeakFinding(
                        category="HISTORY_LEAK",
                        rule_id="GIT_HISTORY_LEAK",
                        file_path=filename,
                        line_num=0,
                        match_text=f"{current_commit} [{status}] {filename}",
                        message="Git 提交历史中残留内部约束/敏感文件（哪怕最新工作树已 rm，历史提交中仍可被翻阅！必须使用 git checkout --orphan clean-main 彻底重塑干净历史）",
                        severity="CRITICAL",
                    ))
    except Exception:
        pass

    return findings


def audit_gitignore_integrity(target_dir: pathlib.Path) -> List[LeakFinding]:
    """审计 .gitignore 规则完整性：防中文主观用语、防过度排除导致演示资产缺失。"""
    findings: List[LeakFinding] = []
    target_dir = target_dir.resolve()
    gitignore_path = target_dir / ".gitignore"
    if not gitignore_path.is_file():
        return findings

    try:
        content = gitignore_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return findings

    # 1. 扫描敏感/主观性中文注释与词汇
    for idx, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if stripped:
            for term in GITIGNORE_SENSITIVE_COMMENT_TERMS:
                if term in stripped:
                    findings.append(LeakFinding(
                        category="GITIGNORE_FLAW",
                        rule_id="GITIGNORE_SUBJECTIVE_COMMENT",
                        file_path=".gitignore",
                        line_num=idx,
                        match_text=stripped,
                        message=f".gitignore 包含内部私有/主观性中文注释「{term}」，开源仓库注释必须使用标准、客观、通用的全英文描述",
                        severity="HIGH",
                    ))

    # 2. 检查演示图表是否被过度忽略 (EX-L01.json, .keep)
    demo_assets_to_test = [
        "site/docs/public/charts/EX-L01.json",
        "site/docs/public/charts/.keep",
    ]

    is_git_repo = (target_dir / ".git").is_dir()
    if is_git_repo:
        for asset in demo_assets_to_test:
            try:
                cmd = ["git", "-C", str(target_dir), "check-ignore", asset]
                proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
                # returncode == 0 说明被忽略了 (ignored)
                if proc.returncode == 0:
                    findings.append(LeakFinding(
                        category="GITIGNORE_FLAW",
                        rule_id="GITIGNORE_OVER_EXCLUSION",
                        file_path=".gitignore",
                        line_num=0,
                        match_text=asset,
                        message=f".gitignore 过度排除：开源自带的演示资产 {asset} 被 Git 忽略！将导致云端 CI 冷启动时因缺失图表报错失败，必须显式配置 !{asset} 白名单",
                        severity="CRITICAL",
                    ))
            except Exception:
                pass
    else:
        if "site/docs/public/charts/*" in content and "!site/docs/public/charts/EX*.json" not in content:
            findings.append(LeakFinding(
                category="GITIGNORE_FLAW",
                rule_id="GITIGNORE_OVER_EXCLUSION",
                file_path=".gitignore",
                line_num=0,
                match_text="site/docs/public/charts/*",
                message=".gitignore 配置了 site/docs/public/charts/* 但未包含 !site/docs/public/charts/EX*.json 白名单，可能导致演示图表丢失并在 CI 报错",
                severity="CRITICAL",
            ))

    return findings


def scan_target(
    target_dir: pathlib.Path,
    include_untracked: bool = False,
    detail: bool = False,
    audit_history: bool = False,
) -> Tuple[List[LeakFinding], int]:
    """执行五层全面扫描，返回 (findings, total_files_scanned)。"""
    findings: List[LeakFinding] = []
    target_dir = target_dir.resolve()
    if not target_dir.exists():
        raise FileNotFoundError(f"Target directory does not exist: {target_dir}")

    # Layer 5.1: .gitignore 规则完整性与演示资产放行审计
    findings.extend(audit_gitignore_integrity(target_dir))

    # Layer 5.2: Git 提交历史穿透审计（可选/指定模式）
    if audit_history:
        findings.extend(audit_git_history(target_dir))

    files = get_scan_files(target_dir, include_untracked=include_untracked)
    total_files = len(files)

    # 真空防护断言
    if total_files == 0:
        return findings, 0

    all_rules = SECRET_RULES + PII_RULES + DOMAIN_RULES

    for full_path in files:
        try:
            rel_path = full_path.relative_to(target_dir).as_posix()
        except ValueError:
            rel_path = str(full_path)

        # Layer 1: 黑名单路径扫描
        for pat, rule_id, desc in FORBIDDEN_PATH_PATTERNS:
            if re.search(pat, rel_path, re.IGNORECASE):
                findings.append(LeakFinding(
                    category="FORBIDDEN_FILE",
                    rule_id=rule_id,
                    file_path=rel_path,
                    line_num=0,
                    match_text=rel_path,
                    message=desc,
                    severity="CRITICAL",
                ))

        # 跳过二进制文件内容正则
        if is_binary_file(full_path):
            continue

        try:
            text = full_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        lines = text.splitlines()
        for idx, line in enumerate(lines, start=1):
            if not line.strip():
                continue

            for rule_id, category, severity, regex, desc in all_rules:
                for match in re.finditer(regex, line):
                    # 优先取 group(2) 或 group(1)（若捕获组分离了赋值 key 与 value），否则取整个 match
                    if match.lastindex and match.lastindex >= 2 and match.group(2):
                        matched_str = match.group(2)
                    elif match.lastindex and match.lastindex >= 1 and match.group(1):
                        matched_str = match.group(1)
                    else:
                        matched_str = match.group(0)

                    # 良性与白名单豁免判断
                    if is_benign(line, matched_str, rel_path=rel_path, rule_id=rule_id):
                        continue

                    findings.append(LeakFinding(
                        category=category,
                        rule_id=rule_id,
                        file_path=rel_path,
                        line_num=idx,
                        match_text=matched_str,
                        message=desc,
                        severity=severity,
                    ))

    return findings, total_files


def generate_markdown_report(findings: List[LeakFinding], target_dir: pathlib.Path) -> str:
    """生成格式化 Markdown 报告。"""
    critical_count = sum(1 for f in findings if f.severity == "CRITICAL")
    high_count = sum(1 for f in findings if f.severity == "HIGH")
    medium_count = sum(1 for f in findings if f.severity == "MEDIUM")
    low_count = sum(1 for f in findings if f.severity == "LOW")

    lines = [
        "# 开源发布前隐私、凭据与防反向泄密拦截报告 (Privacy & Secret Audit Report)",
        "",
        f"- **扫描目标**: `{target_dir}`",
        f"- **总计违规项**: `{len(findings)}`",
        f"- **判定结果**: {'❌ BLOCKED (阻断提交与上传)' if (critical_count > 0 or high_count > 0) else '✅ PASSED (安全无泄漏)'}",
        "",
        "---",
        "",
    ]

    if not findings:
        lines.append("🎉 **全库干净！未发现任何高危凭据、个人路径硬编码、反向泄密约束文档或私有业务资产泄露，完全符合开源发布标准。**\n")
    else:
        lines.append(f"### 🚨 风险统计: 致命(CRITICAL): {critical_count} 处 ｜ 高危(HIGH): {high_count} 处 ｜ 中危: {medium_count} 处 ｜ 提示: {low_count} 处\n")
        lines.append("| 严重度 | 类别 | 规则标识 | 文件路径 | 行号 | 掩码特征 | 拦截说明 |")
        lines.append("| :---: | :---: | :---: | :--- | :---: | :--- | :--- |")
        for f in findings:
            d = f.to_dict()
            badge = "🔴 严重" if d["severity"] == "CRITICAL" else ("🟠 高危" if d["severity"] == "HIGH" else "🟡 中危")
            lines.append(f"| {badge} | `{d['category']}` | `{d['rule_id']}` | `{d['file']}` | {d['line']} | `{d['snippet']}` | {d['message']} |")

        lines.extend([
            "",
            "---",
            "",
            "### 🛠️ 推荐脱敏修复指引 (Remediation Actions)",
            "1. **内部约束文档反向泄密**：绝不可将 `*CONTRACT*.md` 或包含具体私有敏感词的内部负向清单文件推送到公开仓库，请立即移除并纳管在本地；",
            "2. **Git 历史提交泄露**：若历史 commit 中曾包含敏感文件，必须通过 `git checkout --orphan clean-main` 重塑孤立干净历史，删除旧历史；",
            "3. **.gitignore 规则加固**：注释必须全英文；确保 `!site/docs/public/charts/EX*.json` 等演示资产显式白名单放行，防止 CI 运行失败；",
            "4. **凭据/密钥泄露**：严禁硬编码。请将密钥抽离至本地 `.env` 并加入 `.gitignore`，在生产环境通过 CI/CD 环境变量注入；",
            "5. **本地 Windows 绝对路径 / 盘符**：使用 `pathlib.Path(__file__).parent` 相对路径推导，或通过环境变量覆盖；",
            "6. **服务器真实 IP / 私有域名**：在代码和文档中替换为 RFC 5737 教学预留地址（如 `192.0.2.1`）或 RFC 2606 占位域名（`docs.example.com`）；",
            "7. **私有课程与业务资产**：开源版使用 `EX-L01` 示例课程与通用主题（如「现代技术讲义展示引擎」），消除业务私有痕迹。",
        ])

    return "\n".join(lines)


# ==============================================================================
# §3 CLI 主函数
# ==============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(
        description="开源发布前全量隐私、凭据与防反向泄密拦截器 (OpenSource Privacy & Secret Gate)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--target", "-t",
        default=".",
        help="待扫描目标目录（默认为当前工作目录）",
    )
    parser.add_argument(
        "--include-untracked", "-u",
        action="store_true",
        help="即使在 git 仓库内，也扫描所有未跟踪文件（评估误提交风险面）",
    )
    parser.add_argument(
        "--audit-history",
        action="store_true",
        help="启用 Git 全量历史穿透扫描（检查 commit 历史中是否存在残留的内部约束/凭据文件）",
    )
    parser.add_argument(
        "--strict", "-s",
        action="store_true",
        default=True,
        help="严格模式（默认开启）：发现 CRITICAL 或 HIGH 级别违规直接退出码 1 阻断",
    )
    parser.add_argument(
        "--json", "-j",
        dest="json_output",
        help="将审计结果以结构化 JSON 格式写入指定文件",
    )
    parser.add_argument(
        "--report", "-r",
        dest="report_output",
        help="将审计结果以 Markdown 报告格式写入指定文件",
    )
    parser.add_argument(
        "--detail", "-d",
        action="store_true",
        help="打印更详细的命中行上下文",
    )
    parser.add_argument(
        "--list-rules",
        action="store_true",
        help="列出所有配置的规则并退出",
    )

    args = parser.parse_args()

    if args.list_rules:
        print("=== 路径黑名单与防反向泄密规则 (Layer 1) ===")
        for r in FORBIDDEN_PATH_PATTERNS:
            print(f"  [CRITICAL] {r[1]:25s} : {r[2]}")
        print("\n=== 凭据规则 (Layer 2) ===")
        for r in SECRET_RULES:
            print(f"  [{r[2]:^8}] {r[0]:25s} : {r[4]}")
        print("\n=== PII 与环境规则 (Layer 3) ===")
        for r in PII_RULES:
            print(f"  [{r[2]:^8}] {r[0]:25s} : {r[4]}")
        print("\n=== 业务课程与反向泄密规则 (Layer 4) ===")
        for r in DOMAIN_RULES:
            print(f"  [{r[2]:^8}] {r[0]:25s} : {r[4]}")
        print("\n=== 提交历史与 .gitignore 规则 (Layer 5) ===")
        print(f"  [CRITICAL] GIT_HISTORY_LEAK          : 穿透扫描 Git 历史提交记录中的敏感文件 ({', '.join(FORBIDDEN_HISTORY_PATTERNS)})")
        print(f"  [CRITICAL] GITIGNORE_OVER_EXCLUSION  : 检测 .gitignore 是否误阻断开源必备的演示资产 (EX*.json, .keep)")
        print(f"  [  HIGH  ] GITIGNORE_SUBJECTIVE_CMT  : 拦截 .gitignore 中的内部私有/主观性中文注释")
        return 0

    target = pathlib.Path(args.target).resolve()
    print("=" * 76)
    print("🛡️  开源发布前隐私、凭据与防反向泄密扫描拦截器 (Privacy & Secret Gate)")
    print(f"   扫描目标: {target}")
    print(f"   扫描模式: {'全量文件（包含未跟踪文件）' if args.include_untracked else 'Git Tracked 文件（实际发布态）'}")
    print(f"   历史扫描: {'开启 Git 历史深度穿透 (--audit-history)' if args.audit_history else '跳过历史（仅检测当前文件）'}")
    print(f"   门禁契约: {'严格阻断模式 (--strict)' if args.strict else '常规报告模式'}")
    print("=" * 76)

    try:
        findings, total_scanned = scan_target(
            target,
            include_untracked=args.include_untracked,
            detail=args.detail,
            audit_history=args.audit_history,
        )
    except FileNotFoundError as e:
        print(f"\n❌ 参数错误: {e}")
        return 2

    # 真空防护检查
    if total_scanned == 0:
        print(f"\n❌ [真空防护阻断] 扫描文件数为 0！目标路径可能为空或非 Git 仓库，严禁以此断言通过。")
        return 2

    print(f"[*] 扫描完成，共检测 {total_scanned} 个文件。")

    critical_count = sum(1 for f in findings if f.severity == "CRITICAL")
    high_count = sum(1 for f in findings if f.severity == "HIGH")
    medium_count = sum(1 for f in findings if f.severity == "MEDIUM")
    low_count = sum(1 for f in findings if f.severity == "LOW")

    md_report = generate_markdown_report(findings, target)

    if findings:
        print("\n" + "!" * 76)
        print(f"🚨 发现安全违规项: 致命(CRITICAL): {critical_count} ｜ 高危(HIGH): {high_count} ｜ 中危: {medium_count} ｜ 提示: {low_count}")
        print("!" * 76)

        # 打印详细明细表
        print(f"\n{'严重度':^8} | {'类别':^16} | {'规则 ID':^25} | {'位置':^30} | 说明")
        print("-" * 115)
        for f in findings:
            loc = f"{f.file_path}:{f.line_num}" if f.line_num > 0 else f.file_path
            if len(loc) > 30:
                loc = "..." + loc[-27:]
            print(f"{f.severity:^8} | {f.category:^16} | {f.rule_id:^25} | {loc:30s} | {f.message} (片段: {LeakFinding.mask(f.match_text)})")

        if args.json_output:
            out_p = pathlib.Path(args.json_output).resolve()
            out_p.parent.mkdir(parents=True, exist_ok=True)
            report_data = {
                "target": str(target),
                "total_files": total_scanned,
                "summary": {
                    "critical": critical_count,
                    "high": high_count,
                    "medium": medium_count,
                    "low": low_count,
                },
                "findings": [f.to_dict() for f in findings],
            }
            out_p.write_text(json.dumps(report_data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"\n[+] 审计 JSON 报告已写入: {out_p}")

        if args.report_output:
            rep_p = pathlib.Path(args.report_output).resolve()
            rep_p.parent.mkdir(parents=True, exist_ok=True)
            rep_p.write_text(md_report, encoding="utf-8")
            print(f"[+] 审计 Markdown 报告已写入: {rep_p}")

        if (critical_count > 0 or high_count > 0) and args.strict:
            print("\n❌ 结论: BLOCKED (存在致命或高危隐私/反向泄密违规，严禁向公开仓库推送！)")
            return 1
        else:
            print("\n⚠️ 结论: WARN (存在中低风险项，请核实后视情况处理)")
            return 0
    else:
        print("\n✅ 结论: PASS (全绿通过！未发现任何高熵凭据、个人路径硬编码、反向泄密约束文档或私有业务资产泄露)")
        if args.json_output:
            out_p = pathlib.Path(args.json_output).resolve()
            out_p.parent.mkdir(parents=True, exist_ok=True)
            report_data = {
                "target": str(target),
                "total_files": total_scanned,
                "summary": {"critical": 0, "high": 0, "medium": 0, "low": 0},
                "findings": [],
            }
            out_p.write_text(json.dumps(report_data, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.report_output:
            rep_p = pathlib.Path(args.report_output).resolve()
            rep_p.parent.mkdir(parents=True, exist_ok=True)
            rep_p.write_text(md_report, encoding="utf-8")
        return 0


if __name__ == "__main__":
    sys.exit(main())
