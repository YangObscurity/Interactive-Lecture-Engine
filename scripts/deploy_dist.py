# -*- coding: utf-8 -*-
"""把本地 VitePress dist 部署到 HK 服务器 webroot。

流程（比旧版"先清空再上传"更安全）：
  1) 备份现有 webroot -> /var/www/docs.bak.<ts>
  2) 本地把 dist 打成 tar.gz（**单流**）上传，远端解到 /var/www/.docs_staging
     （期间线上完全不受影响）
  3) 原子替换：rm -rf webroot && mv .docs_staging webroot   ← 停机窗口仅此一次 mv
  4) 修权限
  5) 验证：文件数/图表数/figure 数/新工具条/服务健康/关键 chunk 一致

⚠️ 为什么不再"SFTP 逐文件上传"（2026-10-05 实证）：
   622 个文件逐个 put 要上千次往返，长连接会被链路中途 RST ——
   `Socket exception: 远程主机强迫关闭了一个现有的连接 (10054)` / paramiko `EOFError`，
   连续两次部署都死在同一处（同一时刻服务器侧完全健康：load 0.2、无 OOM、sshd 日志正常）。
   改为：本地 tar.gz + 单文件上传 + **失败自动重连重传（最多 5 次）** + 远端解包，
   往返次数从 ~1300 降到个位数（dist 622 文件 / 9MB -> tar.gz 约 2.5MB）。
"""
import os, sys, tarfile, time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 连接参数统一由 scripts/deploy_config.py 解析（环境变量 > 本地 deploy.local.env > 非敏感占位默认）：
#   DEPLOY_HOST / DEPLOY_PORT / DEPLOY_USER / DEPLOY_KEY / DEPLOY_WEBROOT / DEPLOY_DOMAIN
#   DEPLOY_SSH_KEY_PEM   —— 私钥**内容**（沙箱/CI 注入用，落地为 0600 临时文件）
#   DEPLOY_LOCAL_DIST    —— 本地 dist 目录
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deploy_config import (  # noqa: E402
    DEPLOY_AUTH_DOMAIN,
    DEPLOY_DOMAIN,
    DEPLOY_HOST,
    DEPLOY_KEY,
    DEPLOY_PORT,
    DEPLOY_USER,
    DEPLOY_WEBROOT,
)

HOST = DEPLOY_HOST
PORT = DEPLOY_PORT
USER = DEPLOY_USER
KEY = DEPLOY_KEY
LOCAL = os.path.realpath(
    sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-")
    else (os.environ.get("DEPLOY_LOCAL_DIST") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "docs", ".vitepress", "dist"))
)
WEBROOT = DEPLOY_WEBROOT
STAGING = "/var/www/.docs_staging"
TARBALL = "/tmp/dist.tar.gz"
UPLOAD_ATTEMPTS = 5


def run(c, cmd, timeout=300):
    _, so, se = c.exec_command(cmd)
    so.channel.settimeout(timeout)
    out = so.read().decode("utf-8", "replace")
    err = se.read().decode("utf-8", "replace")
    if out.strip():
        print("   " + out.strip())
    if err.strip():
        print("   [stderr] " + err.strip())
    return out, err


def pack_local(local, tar_path):
    """把 dist 打成 tar.gz（arcname 相对 dist，即 tar 内是 index.html / assets/...）。

    单流上传的意义：622 个文件逐个 SFTP put 要上千次往返，长连接会被链路 RST
    （见文件头 ⚠️）。打包后只需传一个文件，往返次数降到个位数。
    """
    n = 0
    with tarfile.open(tar_path, "w:gz") as tf:
        for root, _dirs, files in os.walk(local):
            for f in files:
                p = os.path.join(root, f)
                tf.add(p, arcname=os.path.relpath(p, local))
                n += 1
    return n, os.path.getsize(tar_path)


def resolve_key():
    """定位私钥：DEPLOY_SSH_KEY_PEM（内容）优先，其次 DEPLOY_SSH_KEY / 默认路径。

    为什么支持「内容注入」：沙箱 / CI 里往往只能给环境变量，挂不了文件。
    落地文件显式 chmod 0600，用完不删（/tmp 生命周期内可复用；敏感内容不落仓库）。
    """
    pem = os.environ.get("DEPLOY_SSH_KEY_PEM", "").strip()
    if pem:
        if len(pem) < 200 or "PRIVATE KEY" not in pem:
            raise SystemExit("DEPLOY_SSH_KEY_PEM 看起来不是私钥内容（缺少 PRIVATE KEY 标记）")
        p = "/tmp/deploy_key_%d" % os.getpid()
        with open(p, "w", newline="\n") as f:
            f.write(pem if pem.endswith("\n") else pem + "\n")
        os.chmod(p, 0o600)
        print("   使用 DEPLOY_SSH_KEY_PEM 注入的私钥（已落地 %s，0600）" % p)
        return p
    if not os.path.exists(KEY):
        raise SystemExit(
            "[X] 找不到 SSH 私钥: %s" % KEY,
            "    本机部署：确认该文件存在；或在别的机器/沙箱用环境变量注入：",
            "      DEPLOY_SSH_KEY=<私钥路径>",
            "      DEPLOY_SSH_KEY_PEM=<私钥内容>",
            "    本脚本已支持 DEPLOY_HOST/PORT/USER/WEBROOT/LOCAL_DIST 覆盖。")
    return KEY


def _paramiko():
    """惰性导入：--dry-run / 本地自检不需要 paramiko，只有真连服务器才要。"""
    try:
        import paramiko  # noqa: PLC0415
        return paramiko
    except ImportError:
        raise SystemExit("缺少 paramiko：pip install paramiko（或 python -m pip install --user paramiko）")


def connect():
    paramiko = _paramiko()
    c = paramiko.SSHClient()
    c.load_system_host_keys()
    user_kh = os.path.expanduser("~/.ssh/known_hosts")
    if os.path.exists(user_kh):
        c.load_host_keys(user_kh)
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    key_path = resolve_key()
    try:
        c.connect(HOST, PORT, username=USER, key_filename=key_path, timeout=25)
    except Exception as e:
        msg = str(e)
        if (
            "Server not found in known_hosts" in msg
            or "not found in known_hosts" in msg
            or "BadHostKeyException" in type(e).__name__
        ):
            raise SystemExit(
                "[X] SSH 主机指纹验证失败 (Host key verification failed for %s:%s):\n"
                "    目标主机未收录在 ~/.ssh/known_hosts 中，或主机公钥已变更。\n"
                "    请在终端执行以下命令信任收录公钥后再试：\n"
                "      ssh-keyscan -p %s %s >> ~/.ssh/known_hosts\n"
                "    错误详情: %s" % (HOST, PORT, PORT, HOST, e)
            )
        raise
    return c


def safe_close(c):
    try:
        c.close()
    except Exception:
        pass


def upload_tar(tar_path, remote=TARBALL):
    """上传单个 tar.gz —— 链路会中途 RST，所以失败必须能重连重传。"""
    size = os.path.getsize(tar_path)
    last = None
    for i in range(1, UPLOAD_ATTEMPTS + 1):
        c = None
        try:
            c = connect()
            sftp = c.open_sftp()
            t0 = time.time()
            sftp.put(tar_path, remote)
            got = sftp.stat(remote).st_size
            sftp.close()
            safe_close(c)
            if got != size:
                raise IOError("远端大小 %d != 本地 %d" % (got, size))
            print("   第 %d 次上传成功：%.2f MB，用时 %.1fs"
                  % (i, got / 1024 / 1024, time.time() - t0))
            return
        except Exception as e:
            last = e
            safe_close(c)
            print("   第 %d 次上传失败：%s: %s" % (i, type(e).__name__, e))
            time.sleep(3)
    raise SystemExit("上传连续失败 %d 次，最后错误：%r" % (UPLOAD_ATTEMPTS, last))


def local_chunk():
    for f in os.listdir(os.path.join(LOCAL, "assets")):
        if f.startswith("app.") and f.endswith(".js"):
            return f
    return None


def main():
    global LOCAL
    import argparse
    ap = argparse.ArgumentParser(description="部署 dist 到 HK webroot（凭据/路径支持环境变量覆盖）")
    ap.add_argument("--dry-run", action="store_true",
                    help="只做本地打包与自检（不连服务器）——用于在无凭据环境验证路径与产物")
    ap.add_argument("--local", default=None, help="本地 dist 目录（覆盖 DEPLOY_LOCAL_DIST）")
    ap.add_argument("--webroot", default=None)
    a = ap.parse_args()
    local = os.path.realpath(a.local or LOCAL)
    LOCAL = local
    webroot = a.webroot or WEBROOT
    print("local dist = %s" % local)
    print("remote     = %s:%s@%s:%s" % (USER, webroot, HOST, PORT))
    if not os.path.isdir(local):
        raise SystemExit("[X] 本地 dist 不存在: %s\n    先构建（npm run build），或用 --local / DEPLOY_LOCAL_DIST 指定。" % local)
    if a.dry_run:
        tar_path = os.path.join(os.environ.get("TEMP", "/tmp"), "dist.tar.gz")
        n, size = pack_local(local, tar_path)
        print("[dry-run] packed %d files -> %.2f MB（未连接服务器）" % (n, size / 1024 / 1024))
        print("[dry-run] 私钥检查: %s" % ("OK" if (os.environ.get("DEPLOY_SSH_KEY_PEM")
                                             or os.path.exists(KEY)) else "缺失 -> 真部署会失败"))
        return

    app_chunk = local_chunk()
    print(f"local app chunk = {app_chunk}")

    c = connect()

    print("\n### 1) backup (keep latest 3, outside webroot with 0700 permissions)")
    # 安全说明：备份落盘于 /var/backups/lecture-site/（外部独立路径，chmod 700 保护）。
    # nginx 的 root 为 DEPLOY_WEBROOT (/var/www/example.com)，没有匹配 location/alias，因此 nginx 绝不可能对外服务备份文件。
    BACKUP_BASE = "/var/backups/lecture-site"
    run(c, f"TS=$(date +%Y%m%d-%H%M%S); mkdir -p {BACKUP_BASE} && chmod 700 {BACKUP_BASE} && "
           f"if [ -d {webroot} ]; then "
           f"cp -a {webroot} {BACKUP_BASE}/docs.bak.$TS && chmod -R 700 {BACKUP_BASE}/docs.bak.$TS && "
           f"echo BACKUP={BACKUP_BASE}/docs.bak.$TS && "
           f"ls -1dr {BACKUP_BASE}/docs.bak.* 2>/dev/null | tail -n +4 | xargs -r rm -rf && "
           f"echo -n 'retained_backups=' && ls -1d {BACKUP_BASE}/docs.bak.* 2>/dev/null | wc -l; "
           f"else echo NO_EXISTING_SITE; fi")

    print("\n### 2) pack + stage upload (线上不受影响)")
    tar_path = os.path.join(os.environ.get("TEMP", "."), "dist.tar.gz")
    n, size = pack_local(LOCAL, tar_path)
    print("   packed %d files -> %.2f MB" % (n, size / 1024 / 1024))
    safe_close(c)                 # 打包是本机活；先断开，上传时重连（长空闲连接同样会被掐）
    upload_tar(tar_path)
    c = connect()
    run(c, f"rm -rf {STAGING} && mkdir -p {STAGING} && echo STAGING_READY")
    run(c, f"tar xzf {TARBALL} -C {STAGING} && echo EXTRACTED")
    run(c, f"rm -f {TARBALL}")
    run(c, f"echo -n 'staged files='; find {STAGING} -type f | wc -l")

    print("\n### 3) atomic swap（暂存文件数不足则拒绝替换；重命名切换防停机，失败自动回滚）")
    out, _ = run(c, f"find {STAGING} -type f | wc -l")
    staged = int((out.strip().splitlines() or ["0"])[-1])
    if staged < n:
        raise SystemExit("暂存只有 %d 个文件（本地 %d），拒绝替换" % (staged, n))
    swap_cmd = (
        f"TS=$(date +%Y%m%d-%H%M%S); PREV=\"{webroot}.prev.$TS\"; "
        f"if [ -d \"{webroot}\" ]; then mv \"{webroot}\" \"$PREV\"; fi && "
        f"if mv \"{STAGING}\" \"{webroot}\"; then "
        f"  echo SWAPPED; if [ -d \"$PREV\" ]; then rm -rf \"$PREV\"; fi; "
        f"else "
        f"  echo \"[!] 切换失败，立即恢复旧站...\"; "
        f"  if [ -d \"$PREV\" ]; then mv \"$PREV\" \"{webroot}\"; fi; "
        f"  exit 1; "
        f"fi"
    )
    out, _ = run(c, swap_cmd)
    if "SWAPPED" not in out:
        raise SystemExit("[X] 原子切换失败（旧站已由远端命令恢复），已中止，未执行后续步骤")

    print("\n### 4) permissions")
    run(c, f"chown -R www-data:www-data {webroot} && "
           f"find {webroot} -type d -exec chmod 755 {{}} + && "
           f"find {webroot} -type f -exec chmod 644 {{}} + && echo PERMS_OK")

    print("\n### 4.5) refresh live Notion graph from Notion DB (确保最新打卡不被覆盖)")
    run(c, "curl -s -X POST http://127.0.0.1:8099/api/progress/notion-pull")

    print("\n### 5) verify")
    run(c, f"echo -n 'files='; find {webroot} -type f | wc -l; "
           f"echo -n 'g01 pages='; ls {webroot}/g01/*.html 2>/dev/null | wc -l; "
           f"echo -n 'g02 gi-item (expect 12)='; "
           f"grep -o gi-item {webroot}/g02/index.html | wc -l; "
           f"echo -n 'g02 legacy gi-table (expect 0)='; "
           f"grep -o gi-table {webroot}/g02/index.html | wc -l; "
           f"echo -n 'charts='; ls {webroot}/charts/*.json 2>/dev/null | wc -l; "
           f"echo -n 'figures='; grep -oh 'figure class=\\\"chart\\\"' "
           f"{webroot}/g01/*.html | wc -l; "
           f"echo -n 'legacy data-act in html (expect 0)='; "
           f"grep -oh 'data-act=' {webroot}/g01/*.html | wc -l; "
           f"echo -n 'modal css (expect 1)='; "
           f"grep -l 'chart-modal__panel' {webroot}/assets/style.*.css | wc -l; "
           f"echo -n 'modal js (expect 1)='; "
           f"grep -l 'chart-modal__ops' {webroot}/assets/chunks/*.js | wc -l; "
           f"echo -n 'app chunk on disk='; basename $(ls {webroot}/assets/app.*.js); "
           f"echo -n 'html references='; "
           f"grep -o 'assets/app\\.[A-Za-z0-9_-]*\\.js' {webroot}/g01/L08.html | head -1")

    print("\n### 6) services")
    run(c, "echo -n 'nginx='; systemctl is-active nginx; "
           "echo -n 'authelia='; docker ps --filter name=authelia --format '{{.Status}}'; "
           "nginx -t 2>&1 | tail -1; "
           "echo -n 'disk='; df -h /var/www | tail -1 | awk '{print $4\" free (\"$5\" used)\"}'")

    print("\n### 7) reachability (server-side)")
    run(c, f"for u in 'https://{DEPLOY_DOMAIN}/g01/' 'https://{DEPLOY_AUTH_DOMAIN}/'; do "
           "printf '%s -> ' \"$u\"; "
           "curl -s -o /dev/null -w '%{http_code} loc=%{redirect_url}\\n' -m 15 "
           f"--resolve {DEPLOY_DOMAIN}:443:127.0.0.1 "
           f"--resolve {DEPLOY_AUTH_DOMAIN}:443:127.0.0.1 -k \"$u\"; done", timeout=60)

    c.close()
    print("\nDONE")


if __name__ == "__main__":
    main()
