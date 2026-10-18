r"""sync.py — 一条命令走完「同步源码 → 构建 → 推送 → 部署」。

背景：站点源码原本只在本机（`lecture-site/`），不在任何 git 仓库里 ——
换了机器或误删就没了。现在把它**镜像到本仓库的 `site/`**（只含源码，排除
node_modules / dist / 缓存），并统一入口，避免每次手敲一堆命令。

真实工作副本仍是 `lecture-site/`（在那里编辑、在那里构建）；
`site/` 是随仓库走的镜像，**不要手动编辑 site/**，一律跑本脚本同步。

═══════════════════════════════════════════════════════════════════════════════
路径与配置解析机制
═══════════════════════════════════════════════════════════════════════════════
  1. 工作副本路径：命令行 `--site-src` > 环境变量 `LECTURE_SITE`（由统一配置层
     `scripts/config.py` 读取，模板见 `.env.example`）；未指定时默认退化为
     以本仓库 `site/` 为工作副本的沙箱模式（SELF_MIRROR）。
  2. 仓库根目录：由本文件 `__file__` 动态向上推导自身所在目录，确保操作严格
     限定在当前仓库内。亦支持通过 `--repo` 显式指定。
  3. SSH 凭据：由 `DEPLOY_SSH_KEY`（默认 `~/.ssh/id_ed25519`）或环境变量
     `DEPLOY_SSH_KEY_PEM` 读取注入。

用法：
  python sync.py --check          # 只报告差异（不写盘、不提交）
  python sync.py --sync           # 只同步源码镜像
  python sync.py --build          # 同步 + 构建（npm run build）
  python sync.py --all            # 同步 + 构建 + 提交推送 + 部署到服务器
选项：
  -m "提交说明"                     # 提交信息（默认自动生成）
  --site-src <目录>                 # 覆盖工作副本（等价 LECTURE_SITE）
  --repo <目录>                     # 覆盖仓库根（默认 = 本文件所在目录）
  --dist <目录>                     # 覆盖待部署 dist（等价 DEPLOY_LOCAL_DIST）
"""
import argparse, base64, filecmp, os, pathlib, shutil, subprocess, sys, time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── 统一配置层（scripts/config.py）：私钥路径等敏感默认值统一从这里取 ──────────
# 本文件在仓库根，与 scripts/ 同级，故直接把 scripts/ 加入 sys.path。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import config  # noqa: E402

# ⚠️ 必须用 `os.path.realpath` 规范化**盘符大小写**（c: -> C:）。
#   原因：把 `c:\...` 作为 cwd 交给 node 后，vitepress 的 resolvePageImports 里
#   `path.resolve(srcDir, page)` 得 `c:/...`，而产物 chunk 的 facadeModuleId 是
#   `C:/...` —— 字符串比较失败，`pageChunk` 为 undefined，**构建必挂**：
#   `TypeError: Cannot read properties of undefined (reading 'imports')`
#   （定位过程与复现见 ops/README.md §5.2）
# 路径支持命令行 / 环境变量覆盖（沙箱 / CI / 换机器）：--site-src / LECTURE_SITE。
# 为什么必须可覆盖：在 Linux 沙箱里 realpath('c:\...') 会解析成一个**不存在的相对路径**，
# 于是 --check 会假报「两边一致」——那是静默的错误结论，比报错更危险（2026-10-07 实测）。
# 因此这里不预设写死路径：未指定时安全回退至沙箱模式（SELF_MIRROR）。
SELF_MIRROR = False

# 仓库根：**由本文件位置推导**（本文件就在仓库根）。
# 这是唯一正确的来源 —— 本脚本操作的就是它自己所在的那个仓库，
# 任何「环境变量指到别处」的写法都可能把镜像写进另一个仓库，故不再支持。
_REPO_ROOT = pathlib.Path(os.path.realpath(os.path.dirname(os.path.abspath(__file__))))

# 工作副本：环境变量 LECTURE_SITE > 配置层 LECTURE_SITE > 无。
# 两者皆缺时退化为 "."（配合下面的 SELF_MIRROR 判定走沙箱模式），
# 真正的「源目录不存在」报错逻辑仍在 main() 里把关，不会静默假报一致。
_SITE_SRC_RAW = os.environ.get("LECTURE_SITE") or config.get("LECTURE_SITE") or "."
SITE_SRC = pathlib.Path(os.path.realpath(_SITE_SRC_RAW))
REPO = _REPO_ROOT
MIRROR = REPO / "site"
# 只镜像源码：docs 整棵树（排除构建产物）+ 两个包描述文件
MIRROR_ITEMS = ["docs", "package.json", "package-lock.json"]
EXCLUDE_DIRS = {"dist", "cache", ".temp", "node_modules", "__pycache__"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}


def run(cmd, cwd=None, check=True):
    print("  $ " + (cmd if isinstance(cmd, str) else " ".join(cmd)))
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    for line in out.strip().splitlines()[-6:]:
        print("      " + line[:160])
    if check and r.returncode != 0:
        raise SystemExit("命令失败（exit %d）" % r.returncode)
    return r


def walk_src(root: pathlib.Path):
    """产出 (相对路径, 绝对路径) —— 已应用排除规则。"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for f in filenames:
            if f in EXCLUDE_FILES:
                continue
            p = pathlib.Path(dirpath) / f
            yield p.relative_to(root), p


def _norm(p) -> str:
    """统一成正斜杠 —— 否则 Windows 上 expected(反斜杠) 与 extra(正斜杠) 永远对不上。"""
    return str(p).replace("\\", "/")


def diff_report():
    if SELF_MIRROR:
        return [], [], []
    """比较 lecture-site 与 site/ 镜像，返回 (新增, 修改, 多余)。"""
    added, changed, extra = [], [], []
    expected = set()
    for item in MIRROR_ITEMS:
        src = SITE_SRC / item
        if not src.exists():
            continue
        if src.is_dir():
            for rel, _ in walk_src(src):
                r = _norm(pathlib.Path(item) / rel)
                expected.add(r)
                dst = MIRROR / r
                if not dst.exists():
                    added.append(r)
                elif not filecmp.cmp(_, dst, shallow=False):
                    changed.append(r)
        else:
            r = item
            expected.add(r)
            dst = MIRROR / r
            if not dst.exists():
                added.append(r)
            elif not filecmp.cmp(src, dst, shallow=False):
                changed.append(r)
    if MIRROR.exists():
        for dirpath, dirnames, filenames in os.walk(MIRROR):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for f in filenames:
                r = _norm(pathlib.Path(dirpath).relative_to(MIRROR) / f)
                if r not in expected:
                    extra.append(r)
    return added, changed, extra


def rmtree_force(p: pathlib.Path):
    """Windows 上 rmtree 常因只读属性或句柄占用报 WinError 5 —— 清只读后重试。"""
    import stat

    def _fix(func, path, exc):
        try:
            os.chmod(path, stat.S_IWRITE)
            func(path)
        except Exception:
            pass

    try:
        shutil.rmtree(p, onexc=_fix)
    except TypeError:                      # Python < 3.12 用 onerror
        shutil.rmtree(p, onerror=_fix)
    except Exception:
        pass


def mirror():
    if SELF_MIRROR:
        return
    print("\n### 1) 同步源码镜像 site/")
    # ⚠️ 安全闸门（2026-10-07 踩过、真删过 386 个文件）：
    # 若「源」与「目标」解析到同一路径，下面的 rmtree_force(dst) + copytree(src,dst)
    # 会先把源删掉再复制 → 自我毁灭。凡同路径一律硬拒，不做任何写操作。
    def _same(a: pathlib.Path, b: pathlib.Path) -> bool:
        try:
            return a.resolve() == b.resolve()
        except Exception:  # noqa: BLE001
            return os.path.realpath(str(a)) == os.path.realpath(str(b))

    if _same(SITE_SRC, MIRROR):
        raise SystemExit("❌ SITE_SRC 与 MIRROR 是同一路径（%s）→ 拒绝镜像（会自我删除）。\n"
                         "   沙箱内请直接以仓库 site/ 为工作副本，不要跑 --sync/--build 的镜像步骤。"
                         % SITE_SRC)
    if MIRROR.exists():
        for p in sorted(MIRROR.rglob("*"), reverse=True):
            if p.is_dir() and p.name in EXCLUDE_DIRS:
                rmtree_force(p)
    MIRROR.mkdir(parents=True, exist_ok=True)
    for item in MIRROR_ITEMS:
        src = SITE_SRC / item
        if not src.exists():
            print("  [skip] 源不存在: %s" % item)
            continue
        dst = MIRROR / item
        if _same(src, dst):
            print("  [skip] 源与目标同路径: %s" % item)
            continue
        if src.is_dir():
            if dst.exists():
                rmtree_force(dst)
            shutil.copytree(src, dst,
                            ignore=shutil.ignore_patterns(*EXCLUDE_DIRS, *EXCLUDE_FILES))
        else:
            shutil.copy2(src, dst)
        print("  %s" % item)
    n = sum(1 for _ in walk_src(MIRROR)) if MIRROR.exists() else 0
    print("  镜像文件数: %d" % n)


def free_preview_port(port: int = 4173):
    """构建前把预览服务关掉 —— 它正读着 dist，会让构建写文件失败
    （实测报过 `TypeError: Cannot read properties of undefined (reading 'imports')`）。"""
    try:
        out = subprocess.run('netstat -ano | findstr :%d' % port, shell=True,
                             capture_output=True, text=True).stdout
        pids = {l.split()[-1] for l in out.splitlines()
                if (":%d" % port) in l and "LISTENING" in l}
        for pid in pids:
            subprocess.run("taskkill /F /PID %s" % pid, shell=True,
                           capture_output=True)
        if pids:
            print("  已停止预览服务 PID %s" % ",".join(sorted(pids)))
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--sync", action="store_true")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--deploy", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("-m", "--message", default="")
    ap.add_argument("--branch", default=None, help="推送目标分支（默认当前分支；绝不隐式推 main）")
    ap.add_argument("--site-src", default=None, help="真实工作副本（覆盖 LECTURE_SITE）")
    ap.add_argument("--repo", default=None, help="本仓库根（默认 = 本文件所在目录）")
    ap.add_argument("--dist", default=None, help="dist 目录（覆盖 DEPLOY_LOCAL_DIST）")
    a = ap.parse_args()
    if a.site_src:
        globals()["SITE_SRC"] = pathlib.Path(os.path.realpath(a.site_src))
    if a.repo:
        globals()["REPO"] = pathlib.Path(os.path.realpath(a.repo))
        globals()["MIRROR"] = globals()["REPO"] / "site"
    if a.all:
        a.build = a.push = a.deploy = True
    # ⚠️ 源目录不存在时必须**报错退出**，绝不能"什么都没比较"却打印「两边一致」
    if (a.check or a.sync or a.build) and not SITE_SRC.exists():
        print("❌ 真实工作副本不存在：%s" % SITE_SRC)
        print("   请用 --site-src <目录> 或环境变量 LECTURE_SITE=<目录> 指定。")
        print("   （沙箱内若已把仓库 site/ 当工作副本，可用 --site-src <仓库>/site）")
        raise SystemExit(2)
    if not REPO.exists():
        print("❌ 仓库根不存在：%s（用 --repo 指定）" % REPO)
        raise SystemExit(2)
    global SELF_MIRROR
    try:
        SELF_MIRROR = SITE_SRC.resolve() == MIRROR.resolve()
    except Exception:  # noqa: BLE001
        SELF_MIRROR = False
    if SELF_MIRROR and (a.check or a.sync or a.build):
        print("ℹ️  工作副本 == 镜像（%s）：跳过镜像/差异步骤 —— 这是沙箱模式，"
              "site/ 本身就是工作副本。" % SITE_SRC)
    if not any([a.check, a.sync, a.build, a.push, a.deploy]):
        a.check = True

    if a.check:
        print("### 差异检查（lecture-site -> site/）")
        added, changed, extra = diff_report()
        print("  新增 %d  改动 %d  多余 %d" % (len(added), len(changed), len(extra)))
        for label, items in (("新增", added), ("改动", changed), ("多余", extra)):
            for x in items[:12]:
                print("    +%s %s" % (label, x))
        if not (added or changed or extra):
            print("  两边一致")
        return

    if a.sync or a.build or a.push or a.deploy:
        mirror()

    if a.build:
        print("\n### 2) 构建（在 lecture-site 里跑，dist 也在那边）")
        free_preview_port()          # 先停掉预览，避免它占着 dist 让构建失败
        # 必须用字符串走 shell：Windows 上 npm 实际是 npm.cmd，列表调用会 WinError 2
        # ⚠️ check=True：**构建失败必须中止**，否则会把上一次的旧 dist 推上线（踩过）
        run("npm run build", cwd=str(SITE_SRC), check=True)

    if a.push:
        print("\n### 3) 提交并推送")
        msg = a.message or ("sync site source %s" % time.strftime("%Y-%m-%d %H:%M"))
        run(["git", "add", "-A"], cwd=str(REPO), check=False)
        run(["git", "commit", "-m", msg], cwd=str(REPO), check=False)
        # 凭据：优先用环境变量 GITHUB_TOKEN（一次性 header，不落盘）；
        # 没设就照常 push —— 走已配置好的凭据助手（Git Credential Manager）。
        tok = os.environ.get("GITHUB_TOKEN", "").strip()
        extra = []
        if tok:
            b64 = base64.b64encode(("x-access-token:" + tok).encode()).decode()
            extra = ["-c", "credential.helper=",
                     "-c", "http.extraheader=AUTHORIZATION: basic " + b64]
            print("  （使用 GITHUB_TOKEN，不写入 .git/config）")
        br = a.branch
        if not br:
            r = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=str(REPO), check=False)
            br = (r.stdout or "").strip() or "main"
        print("   推送分支: %s（用 --branch 覆盖；绝不隐式推 main）" % br)
        run(["git"] + extra + ["push", "origin", br], cwd=str(REPO), check=False)

    if a.deploy:
        print("\n### 4) 部署到服务器")
        dist = os.path.realpath(a.dist or (SITE_SRC / "docs" / ".vitepress" / "dist"))
        env = dict(os.environ)
        env["DEPLOY_LOCAL_DIST"] = dist
        # 私钥判定：统一走跨平台标准约定 ~/.ssh/id_ed25519（os.path.expanduser 展开），
        # 并支持通过 DEPLOY_SSH_KEY 覆盖，与 scripts/config.py 配置层保持单一真源。
        key_path = config.expand_path(
            env.get("DEPLOY_SSH_KEY") or config.get("DEPLOY_SSH_KEY"))
        has_key = bool(env.get("DEPLOY_SSH_KEY_PEM")) or bool(key_path and os.path.exists(key_path))
        deploy_script = REPO / "scripts" / "deploy_dist.py"
        if not deploy_script.exists():
            print("   ℹ️ 未配置外部部署扩展脚本（scripts/deploy_dist.py），跳过远程分发。")
        elif not has_key:
            print("   ⏭ 跳过部署：找不到 SSH 私钥（默认约定 %s）" % (key_path or "~/.ssh/id_ed25519"))
            print("      本机部署需该文件存在；沙箱/CI 用 DEPLOY_SSH_KEY_PEM 注入；")
            print("      也可用 DEPLOY_SSH_KEY=<私钥路径> 指定（详见仓库根 .env.example）。")
            run([sys.executable, str(deploy_script), "--dry-run", "--local", dist], check=False)
        else:
            print("   dist = %s" % dist)
            r = subprocess.run([sys.executable, str(deploy_script),
                                "--local", dist], env=env, capture_output=True, text=True)
            for ln in ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-12:]:
                print("      " + ln[:160])
            if r.returncode != 0:
                print("   ⚠️ 部署脚本退出码 %d" % r.returncode)

        integrity_script = REPO / "scripts" / "deploy_integrity.py"
        if integrity_script.exists():
            run([sys.executable, str(integrity_script)], check=False)

    print("\n完成。")


if __name__ == "__main__":
    main()
