#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deploy_dist_cli.py — 用 **OpenSSH 命令行**复刻 `deploy_dist.py` 的安全部署流程。

为什么需要：`deploy_dist.py` 依赖 `paramiko`，而沙箱 / 精简 CI 里往往装不上
（PyPI 不可达，实测 `pip install paramiko` 失败），但 **openssh 客户端是有的**。
本脚本用 `ssh` 命令行完成同样的「备份 → 单流上传 → 暂存解包 → 计数校验 → 原子替换 → 权限 → 核验」，
安全语义与 deploy_dist.py 一致（**停机窗口只有一次 `mv`**）。

环境变量：DEPLOY_HOST / DEPLOY_PORT / DEPLOY_USER / DEPLOY_SSH_KEY / DEPLOY_WEBROOT / DEPLOY_LOCAL_DIST
用法：python scripts/deploy_dist_cli.py --local site/docs/.vitepress/dist --key /tmp/dep_key [--dry-run]
"""
import argparse
import os
import subprocess
import sys
import tarfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy_config import (  # noqa: E402
    DEPLOY_DOMAIN,
    DEPLOY_HOST,
    DEPLOY_KEY,
    DEPLOY_PORT,
    DEPLOY_USER,
    DEPLOY_WEBROOT,
)

HOST = DEPLOY_HOST
PORT = str(DEPLOY_PORT)
USER = DEPLOY_USER
KEY = DEPLOY_KEY
WEBROOT = DEPLOY_WEBROOT
STAGING = "/var/www/.docs_staging"
TARBALL = "/tmp/dist.tar.gz"


def _opts(key):
    return ["-i", key, "-p", str(PORT), "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20"]


def ssh(key, cmd, timeout=300):
    r = subprocess.run(["ssh"] + _opts(key) + ["%s@%s" % (USER, HOST), cmd],
                       capture_output=True, text=True, timeout=timeout)
    out, err = (r.stdout or "").strip(), (r.stderr or "").strip()
    if out:
        print("   " + out.replace("\n", "\n   ")[:1500])
    if err and r.returncode != 0:
        print("   [stderr] " + err[:400])
        if "Host key verification failed" in err:
            print(
                "\n[X] SSH 主机指纹验证失败 (Host key verification failed for %s:%s):\n"
                "    目标主机公钥未收录在 ~/.ssh/known_hosts 中。\n"
                "    请在终端执行以下命令将该主机公钥信任收录后再试：\n"
                "      ssh-keyscan -p %s %s >> ~/.ssh/known_hosts\n" % (HOST, PORT, PORT, HOST)
            )
    return out, err, r.returncode


def pack(local, tar_path):
    n = 0
    with tarfile.open(tar_path, "w:gz") as tf:
        for root, _d, files in os.walk(local):
            for f in files:
                p = os.path.join(root, f)
                tf.add(p, arcname=os.path.relpath(p, local))
                n += 1
    return n, os.path.getsize(tar_path)


def upload(local_tar, key, attempts=4):
    """单流上传（`ssh 'cat > file'`）：逐文件 SFTP 会被链路 RST，单流往返最少。"""
    data = open(local_tar, "rb").read()
    for i in range(1, attempts + 1):
        r = subprocess.run(["ssh"] + _opts(key) + ["%s@%s" % (USER, HOST),
                                                   "cat > %s" % TARBALL],
                           input=data, capture_output=True, timeout=600)
        if r.returncode == 0:
            out, _e, _c = ssh(key, "stat -c %%s %s" % TARBALL)
            got = int((out.strip().splitlines() or ["0"])[-1] or 0)
            if got == len(data):
                print("   上传完成 %d 字节" % got)
                return True
            print("   大小不符（远 %d / 本 %d），重传 %d/%d" % (got, len(data), i, attempts))
        else:
            print("   上传失败（exit %d），重试 %d/%d" % (r.returncode, i, attempts))
        time.sleep(2 * i)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", default=os.environ.get("DEPLOY_LOCAL_DIST",
                                                     "site/docs/.vitepress/dist"))
    ap.add_argument("--key", default=KEY)
    ap.add_argument("--webroot", default=WEBROOT)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    local = os.path.realpath(a.local)
    key = os.path.realpath(a.key)
    print("local dist = %s" % local)
    print("remote     = %s@%s:%s  webroot=%s" % (USER, HOST, PORT, a.webroot))
    if not os.path.isdir(local):
        raise SystemExit("[X] 本地 dist 不存在: %s" % local)
    if not os.path.exists(key):
        raise SystemExit("[X] 私钥不存在: %s" % key)
    n_local = sum(1 for _r, _d, fs in os.walk(local) for _ in fs)
    print("本地文件数 = %d" % n_local)
    if a.dry_run:
        print("\n[dry-run] 自检通过：本地产物与私钥路径均正常（跳过连通性/备份/上传/替换）")
        return

    print("\n### 0) 连通性")
    out, _e, rc = ssh(key, "whoami; ls -d %s >/dev/null && echo WEBROOT_OK" % a.webroot)
    if rc != 0 or "WEBROOT_OK" not in out:
        raise SystemExit("[X] 连通性或 webroot 检查失败")

    ts = time.strftime("%Y%m%d-%H%M%S")
    print("\n### 1) 备份现有 webroot（仅保留最近 3 份，落盘于独立 /var/backups/lecture-site，chmod 700 保护）")
    # 安全说明：备份目录位于 webroot 之外，且 nginx 根目录指向特定 webroot，无对应 location/alias，无法对外提供备份下载。
    backup_base = "/var/backups/lecture-site"
    ssh(key, "mkdir -p %s && chmod 700 %s && "
             "if [ -d %s ]; then cp -a %s %s/docs.bak.%s && chmod -R 700 %s/docs.bak.%s && "
             "echo BACKUP=%s/docs.bak.%s && "
             "ls -1dr %s/docs.bak.* 2>/dev/null | tail -n +4 | xargs -r rm -rf && "
             "echo -n 'retained_backups=' && ls -1d %s/docs.bak.* 2>/dev/null | wc -l; "
             "else echo NO_EXISTING_SITE; fi"
        % (backup_base, backup_base, a.webroot, a.webroot, backup_base, ts, backup_base, ts, backup_base, ts, backup_base, backup_base))

    print("\n### 2) 打包 + 单流上传（线上不受影响）")
    tar_path = "/tmp/dist_upload.tar.gz"
    n, size = pack(local, tar_path)
    print("   packed %d files -> %.2f MB" % (n, size / 1024 / 1024))
    if not upload(tar_path, key):
        raise SystemExit("[X] 上传失败")
    ssh(key, "rm -rf %s && mkdir -p %s && tar xzf %s -C %s && rm -f %s && echo EXTRACTED"
        % (STAGING, STAGING, TARBALL, STAGING, TARBALL))

    print("\n### 3) 计数校验 + 原子替换（先暂存移位，失败自动回滚，杜绝停机空窗）")
    out, _e, _c = ssh(key, "find %s -type f | wc -l" % STAGING)
    staged = int((out.strip().splitlines() or ["0"])[-1] or 0)
    print("   暂存文件数 = %d（本地 %d）" % (staged, n))
    if staged < n:
        raise SystemExit("[X] 暂存文件数不足，**拒绝替换**（线上保持原样）")
    swap_cmd = (
        "TS=$(date +%%Y%%m%%d-%%H%%M%%S); PREV=\"%s.prev.$TS\"; "
        "if [ -d \"%s\" ]; then mv \"%s\" \"$PREV\"; fi && "
        "if mv \"%s\" \"%s\"; then "
        "  echo SWAPPED; if [ -d \"$PREV\" ]; then rm -rf \"$PREV\"; fi; "
        "else "
        "  echo \"[!] 切换失败，立即恢复旧站...\"; "
        "  if [ -d \"$PREV\" ]; then mv \"$PREV\" \"%s\"; fi; "
        "  exit 1; "
        "fi" % (a.webroot, a.webroot, a.webroot, STAGING, a.webroot, a.webroot)
    )
    out, _e, _c = ssh(key, swap_cmd)
    if "SWAPPED" not in out:
        raise SystemExit("[X] 原子切换失败（旧站已由远端命令恢复），已中止，未执行后续步骤")

    print("\n### 4) 权限")
    ssh(key, "chown -R www-data:www-data %s && find %s -type d -exec chmod 755 {} + && "
             "find %s -type f -exec chmod 644 {} + && echo PERMS_OK"
        % (a.webroot, a.webroot, a.webroot))

    print("\n### 5) 核验")
    ssh(key, "cd %s && echo -n 'files='; find . -type f | wc -l; "
             "echo -n 'g01 pages='; ls g01/*.html | wc -l; "
             "echo -n 'charts json='; ls charts/*.json | wc -l; "
             "echo -n 'g01/L01 katex nodes='; grep -o 'class=\"katex\"' g01/L01.html | wc -l; "
             "echo -n 'g01/L01 math-node='; grep -o 'class=\"math-node' g01/L01.html | wc -l; "
             "echo -n 'g01 figures='; grep -oh 'figure class=\"chart\"' g01/*.html | wc -l; "
             "echo -n 'katex fonts='; ls assets/KaTeX_* 2>/dev/null | wc -l; "
             "echo -n 'legacy data-act (expect 0)='; grep -oh 'data-act=' g01/*.html | wc -l"
        % a.webroot)

    print("\n### 6) 服务与磁盘")
    ssh(key, "echo -n 'nginx='; systemctl is-active nginx; "
             "echo -n 'authelia='; docker ps --filter name=authelia --format '{{.Status}}'; "
             "echo -n 'disk='; df -h /var/www | tail -1 | awk '{print $4\" free (\"$5\" used)\"}'")

    print("\n### 7) 服务端可达性")
    ssh(key, f"for u in https://{DEPLOY_DOMAIN}/g01/L01.html https://{DEPLOY_DOMAIN}/; do "
             "printf '%s -> ' $u; curl -s -o /dev/null -w '%{http_code}\\n' -k $u; done")
    print("\n完成。")


if __name__ == "__main__":
    main()
