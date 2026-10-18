# -*- coding: utf-8 -*-
"""mount_content.py —— 开源缓冲架构内容插拔管理中枢 (Content Mount & Lifecycle Manager)

核心定位：
  在「外部内容接入（Hot-Plug In）」与「纯净引擎发布（Clean & Export）」之间建立工业级桥梁。
  支持讲义、图表及元数据的一键秒级挂载、精准卸载、契约验证、反向导出与脱敏清理。

特性：
  - 零拷贝接入加速：支持 Windows Junction / 软链接与跨平台自适应，失败平滑降级为拷贝；
  - 保护白名单守卫：严格保护引擎核心文件（.vitepress/, index.md, examples/ 等），绝不误删；
  - 精准回滚卸载：基于原子写入的 `.content-mount.json` 清单执行 100% 干净卸载；
  - 沙箱安全防线：严格执行路径防逃逸（Anti-Path-Traversal）校验；
  - 契约双向对账：内置 figure 锚点与 sidecar JSON 的 1:1 双向校验。

退出码标准：
  0: 操作成功 / 校验通过 (PASS)
  1: 契约校验不通过 / 数据不一致 (VERIFICATION FAILURE)
  2: 参数错误 / 路径不存在 (INVALID ARGS)
  3: 安全拦截 / 路径越界阻断 (SECURITY VIOLATION)
"""

import argparse
import collections
import datetime
import io
import json
import os
import pathlib
import re
import shutil
import stat
import sys

# 跨平台输出编码防护
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 正则匹配 figure 锚点
FIG_PATTERN = re.compile(r'<figure class="chart"([^>]*)>')

# 引擎保护白名单：任何情况下卸载或清理均严禁误删的文件/目录（相对于 docs 根目录）
PROTECTED_DOCS_ITEMS = {
    ".vitepress",
    "index.md",
    "examples",
    "public",
    os.path.normpath("public/charts/.keep"),
    os.path.normpath("public/charts/EX-L01.json"),
    os.path.normpath("public/charts/EX-L02.json"),
    os.path.normpath("public/favicon.ico"),
    os.path.normpath("public/favicon.svg"),
    os.path.normpath("public/apple-touch-icon.png"),
    os.path.normpath("public/icon-192.png"),
    os.path.normpath("public/showcase"),
}


class SecurityViolationError(Exception):
    """沙箱路径越界或非法逃逸异常"""
    pass


class ContentMountManager:
    """内容挂载与生命周期管理器"""

    def __init__(self, buffer_root: pathlib.Path, target_docs: pathlib.Path = None, dry_run: bool = False):
        self.buffer_root = buffer_root.resolve()
        self.dry_run = dry_run

        if target_docs is None:
            self.target_docs = (self.buffer_root / "site" / "docs").resolve()
        else:
            self.target_docs = target_docs.resolve()

        self._assert_safe_directory(self.target_docs, allow_create=True)
        self.state_file = self.target_docs / ".content-mount.json"

    def _assert_safe_directory(self, target_dir: pathlib.Path, allow_create: bool = False):
        """沙箱安全检查：防止向根目录或非法的系统关键路径写入或清空"""
        resolved = target_dir.resolve()
        # 严禁在盘符根目录（如 C:\, /）上操作
        if len(resolved.parts) <= 1 or resolved == resolved.parent:
            raise SecurityViolationError(f"安全阻断：禁止将系统根路径作为操作目标: {resolved}")

        # 禁止操作 Windows 核心系统目录
        system_paths = [os.environ.get("WINDIR", "C:\\Windows"), os.environ.get("SystemRoot", "C:\\Windows")]
        for sp in system_paths:
            if sp:
                sp_resolved = pathlib.Path(sp).resolve()
                try:
                    if resolved == sp_resolved or sp_resolved in resolved.parents:
                        raise SecurityViolationError(f"安全阻断：禁止操作 Windows 系统目录: {resolved}")
                except Exception:
                    pass

        if not resolved.exists():
            if allow_create and not self.dry_run:
                resolved.mkdir(parents=True, exist_ok=True)
            elif not allow_create:
                raise FileNotFoundError(f"目标目录不存在: {resolved}")

    def _assert_child_of_target(self, child_path: pathlib.Path):
        """断言操作路径必须位于 target_docs 内部，严禁路径逃逸"""
        # 严禁用 child_path.resolve()，当 child_path 为符号链接/Junction 时会穿透到源目录
        norm_child = pathlib.Path(os.path.abspath(child_path))
        norm_target = pathlib.Path(os.path.abspath(self.target_docs))
        try:
            norm_child.relative_to(norm_target)
        except ValueError:
            raise SecurityViolationError(f"安全阻断：路径越界（路径逃逸）: {norm_child} 不在 {norm_target} 内")

    def is_engine_protected(self, rel_path: str) -> bool:
        """检查指定相对路径是否属于引擎保护白名单"""
        norm = os.path.normpath(rel_path).replace("\\", "/")
        # 挂载的课程元信息文件由 mount_content 管理，允许卸载与清理
        if norm == ".vitepress/content-groups.mts":
            return False
        if norm.startswith("public/charts/EX-") and norm.endswith(".json"):
            return True
        for prot in PROTECTED_DOCS_ITEMS:
            prot_norm = os.path.normpath(prot).replace("\\", "/")
            if norm == prot_norm:
                return True
            # public 目录自身受保护，但其下普通子项（除专门列出的项外）不由通配前缀继承
            if prot_norm != "public" and norm.startswith(prot_norm + "/"):
                return True
        return False

    def load_mount_state(self) -> dict:
        """读取当前的挂载状态元数据"""
        if not self.state_file.exists():
            return {}
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[WARN] 无法读取状态文件 {self.state_file}: {e}", file=sys.stderr)
            return {}

    def save_mount_state(self, state: dict):
        """原子写入挂载状态元数据"""
        if self.dry_run:
            return
        tmp_file = self.state_file.with_suffix(".tmp")
        tmp_file.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
        if tmp_file.exists():
            os.replace(tmp_file, self.state_file)

    def _link_or_copy_directory(self, src_dir: pathlib.Path, dst_dir: pathlib.Path, prefer_symlink: bool) -> str:
        """自适应目录挂载：Windows Junction / Symlink / Copy 自动降级"""
        try:
            if src_dir.resolve() == dst_dir.resolve():
                return "identical"
        except Exception:
            pass

        if dst_dir.exists() or os.path.islink(dst_dir):
            self._safe_remove_item(dst_dir)

        if self.dry_run:
            return "dry_run"

        if prefer_symlink:
            # 策略 1: Windows 优先尝试 Directory Junction (普通权限即可，无需管理员/开发者模式)
            if sys.platform == "win32":
                try:
                    import _winapi
                    _winapi.CreateJunction(str(src_dir.resolve()), str(dst_dir.resolve()))
                    return "junction"
                except Exception:
                    pass

            # 策略 2: 标准目录软链接
            try:
                os.symlink(str(src_dir.resolve()), str(dst_dir.resolve()), target_is_directory=True)
                return "symlink"
            except Exception:
                pass

        # 策略 3: 平滑降级为全量目录硬拷贝
        shutil.copytree(str(src_dir), str(dst_dir))
        return "copy"

    def _link_or_copy_file(self, src_file: pathlib.Path, dst_file: pathlib.Path, prefer_symlink: bool) -> str:
        """自适应文件挂载：文件软链接 / 硬链接 / 拷贝 自动降级"""
        try:
            if src_file.resolve() == dst_file.resolve():
                return "identical"
        except Exception:
            pass

        if dst_file.exists() or os.path.islink(dst_file):
            self._safe_remove_item(dst_file)

        if self.dry_run:
            return "dry_run"

        dst_file.parent.mkdir(parents=True, exist_ok=True)

        if prefer_symlink:
            try:
                os.symlink(str(src_file.resolve()), str(dst_file.resolve()))
                return "symlink"
            except Exception:
                pass

        shutil.copy2(str(src_file), str(dst_file))
        return "copy"

    def _safe_remove_item(self, path: pathlib.Path):
        """安全删除指定路径，正确识别 Junction / Symlink，防止误删源内容"""
        if not (path.exists() or os.path.islink(path)):
            return

        if self.dry_run:
            return

        # 判断是否是 Junction 或软链接
        is_link = os.path.islink(path)
        is_junc = False
        if hasattr(os.path, "isjunction"):
            is_junc = os.path.isjunction(path)

        def _handle_remove_readonly(func, p, exc_info):
            try:
                os.chmod(p, stat.S_IWRITE)
                func(p)
            except Exception:
                pass

        if is_link or is_junc:
            if path.is_dir():
                try:
                    os.rmdir(path)
                except PermissionError:
                    try:
                        os.chmod(path, stat.S_IWRITE)
                        os.rmdir(path)
                    except Exception:
                        pass
                except Exception:
                    path.unlink(missing_ok=True)
            else:
                try:
                    path.unlink(missing_ok=True)
                except PermissionError:
                    try:
                        os.chmod(path, stat.S_IWRITE)
                        path.unlink(missing_ok=True)
                    except Exception:
                        pass
        elif path.is_dir():
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=_handle_remove_readonly)
            else:
                shutil.rmtree(path, onerror=_handle_remove_readonly)
        else:
            try:
                path.unlink(missing_ok=True)
            except PermissionError:
                try:
                    os.chmod(path, stat.S_IWRITE)
                    path.unlink(missing_ok=True)
                except Exception:
                    pass

    def locate_content_source(self, source_arg: str) -> pathlib.Path:
        """定位内容源：支持绝对路径、相对路径或 content-sources/ 预设名称"""
        p = pathlib.Path(source_arg)
        if p.exists() and p.is_dir():
            return p.resolve()

        # 检查 content-sources 预设
        preset = self.buffer_root / "content-sources" / source_arg
        if preset.exists() and preset.is_dir():
            return preset.resolve()

        raise FileNotFoundError(f"未找到有效的内容源: {source_arg}（已尝试路径与 content-sources/{source_arg}）")

    def mount(self, source_arg: str, prefer_symlink: bool = True, force: bool = False) -> dict:
        """执行内容挂载"""
        source_dir = self.locate_content_source(source_arg)
        current_state = self.load_mount_state()

        if current_state and not force:
            raise RuntimeError(
                f"当前 docs 目录已挂载内容源 '{current_state.get('source_name')}'。"
                f"请先运行 --unmount 卸载，或使用 --force 强制覆盖。"
            )

        if current_state and force:
            print("[INFO] 检测到已有挂载，正在执行前置覆盖卸载...")
            self.unmount(force=True)

        meta_file = source_dir / "content-source.json"
        source_meta = {}
        if meta_file.exists():
            try:
                source_meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[WARN] 无法读取内容源元数据 {meta_file}: {e}")

        source_name = source_meta.get("name", source_dir.name)
        charts_dir_name = source_meta.get("charts_dir", "charts")
        source_charts = source_dir / charts_dir_name
        if not source_charts.exists() and (source_dir / "public" / "charts").exists():
            source_charts = source_dir / "public" / "charts"

        # 发现需要挂载的课程目录
        group_dirs = []
        if "groups" in source_meta and isinstance(source_meta["groups"], list):
            for g in source_meta["groups"]:
                gid = g.get("id") if isinstance(g, dict) else str(g)
                gpath = source_dir / gid
                if gpath.exists() and gpath.is_dir():
                    group_dirs.append(gpath)
        else:
            for item in sorted(source_dir.iterdir()):
                if item.is_dir() and item.name != charts_dir_name and not item.name.startswith("."):
                    if item.name == "public" or self.is_engine_protected(item.name):
                        continue
                    if any(item.glob("L*.md")) or (item.name.startswith("g") and item.name[1:].isdigit()) or item.name == "dt":
                        group_dirs.append(item)

        mounted_items = []

        # 1. 挂载课程讲义目录
        for gdir in group_dirs:
            rel_group = gdir.name
            target_group = self.target_docs / rel_group
            self._assert_child_of_target(target_group)

            if self.is_engine_protected(rel_group):
                continue

            mode = self._link_or_copy_directory(gdir, target_group, prefer_symlink)
            mounted_items.append({
                "type": "directory",
                "rel_path": rel_group,
                "mode": mode,
                "source_path": str(gdir)
            })

        # 2. 挂载 sidecar 图表
        charts_target = self.target_docs / "public" / "charts"
        self._assert_child_of_target(charts_target)
        if not charts_target.exists() and not self.dry_run:
            charts_target.mkdir(parents=True, exist_ok=True)

        if source_charts.exists() and source_charts.is_dir():
            for cjson in sorted(source_charts.glob("*.json")):
                rel_chart = f"public/charts/{cjson.name}"
                target_chart = self.target_docs / "public" / "charts" / cjson.name
                self._assert_child_of_target(target_chart)

                mode = self._link_or_copy_file(cjson, target_chart, prefer_symlink)
                mounted_items.append({
                    "type": "file",
                    "rel_path": rel_chart,
                    "mode": mode,
                    "source_path": str(cjson)
                })

        # 3. 挂载课程元数据 content-groups.mts（若源目录或其 .vitepress/ 存在 groups.mts 或 content-groups.mts）
        source_groups_file = None
        candidates = [
            source_dir / "content-groups.mts",
            source_dir / "groups.mts",
            source_dir / ".vitepress" / "content-groups.mts",
            source_dir / ".vitepress" / "groups.mts",
        ]
        for c in candidates:
            if c.exists() and c.is_file():
                source_groups_file = c
                break

        if source_groups_file:
            target_groups_file = self.target_docs / ".vitepress" / "content-groups.mts"
            self._assert_child_of_target(target_groups_file)
            mode = self._link_or_copy_file(source_groups_file, target_groups_file, prefer_symlink)
            mounted_items.append({
                "type": "file",
                "rel_path": ".vitepress/content-groups.mts",
                "mode": mode,
                "source_path": str(source_groups_file)
            })

        new_state = {
            "source_name": source_name,
            "source_path": str(source_dir),
            "mount_time": datetime.datetime.now().isoformat(),
            "prefer_symlink": prefer_symlink,
            "mounted_items": mounted_items
        }

        self.save_mount_state(new_state)
        return new_state

    def unmount(self, force: bool = False) -> list:
        """执行内容回滚与卸载"""
        state = self.load_mount_state()
        if not state:
            if not force:
                print("[INFO] 当前没有已记录的挂载内容。")
            return []

        mounted_items = state.get("mounted_items", [])
        unmounted_records = []

        # 逆序删除，先删具体文件，再删目录
        for item in reversed(mounted_items):
            rel_path = item.get("rel_path")
            target_path = self.target_docs / rel_path
            self._assert_child_of_target(target_path)

            if self.is_engine_protected(rel_path):
                print(f"[WARN] 跳过保护的引擎文件: {rel_path}")
                continue

            self._safe_remove_item(target_path)
            unmounted_records.append(rel_path)

        # 移除挂载状态文件
        if not self.dry_run and self.state_file.exists():
            self.state_file.unlink(missing_ok=True)

        return unmounted_records

    def clean(self) -> list:
        """强制清理所有非引擎自带的文件，恢复引擎初始基准状态"""
        cleaned_items = []
        if not self.target_docs.exists():
            return cleaned_items

        for item in sorted(self.target_docs.iterdir()):
            rel_path = item.relative_to(self.target_docs).as_posix()

            # 忽略 .git 等 VCS 目录
            if item.name.startswith(".git"):
                continue

            # 特殊处理 public 目录：保留 public 自身及其白名单文件，清除非法/临时挂载文件
            if rel_path == "public" and item.is_dir():
                charts_dir = item / "charts"
                if charts_dir.exists():
                    for chart_file in sorted(charts_dir.iterdir()):
                        chart_rel = chart_file.relative_to(self.target_docs).as_posix()
                        if not self.is_engine_protected(chart_rel):
                            self._safe_remove_item(chart_file)
                            cleaned_items.append(chart_rel)
                continue

            # 检查是否属于受保护的白名单
            if self.is_engine_protected(rel_path):
                continue

            self._assert_child_of_target(item)
            self._safe_remove_item(item)
            cleaned_items.append(rel_path)

        # 检查并清除可能挂载的 content-groups.mts
        content_groups = self.target_docs / ".vitepress" / "content-groups.mts"
        if content_groups.exists():
            self._safe_remove_item(content_groups)
            cleaned_items.append(".vitepress/content-groups.mts")

        if not self.dry_run and self.state_file.exists():
            self.state_file.unlink(missing_ok=True)

        return cleaned_items

    def verify(self) -> tuple[int, dict]:
        """校验讲义 Markdown 与 sidecar JSON 契约对账"""
        if not self.target_docs.exists():
            return 1, {"error": f"docs 目录不存在: {self.target_docs}"}

        charts_dir = self.target_docs / "public" / "charts"
        bad_count = 0
        n_pages = 0
        n_figs = 0
        counts = collections.Counter()
        type_by_key = collections.Counter()
        details = []

        # 发现所有课程组目录（排除受保护目录和隐藏目录）
        group_dirs = sorted([
            p for p in self.target_docs.iterdir()
            if p.is_dir()
            and not p.name.startswith(".")
            and p.name != "public"
            and not self.is_engine_protected(p.name)
        ])

        for gdir in group_dirs:
            gid = gdir.name.upper()
            for md_file in sorted(gdir.glob("L*.md")):
                n_pages += 1
                content = md_file.read_text(encoding="utf-8")
                json_name = f"{gid}-{md_file.stem}.json"
                json_path = charts_dir / json_name

                if not json_path.exists():
                    if FIG_PATTERN.search(content) is not None:
                        bad_count += 1
                        msg = f"MISSING JSON: {json_name} (对应 {gdir.name}/{md_file.name})"
                        details.append(msg)
                    continue

                try:
                    data = json.loads(json_path.read_text(encoding="utf-8"))
                except Exception as e:
                    bad_count += 1
                    msg = f"BAD JSON: {json_name} 语法解析错误: {e}"
                    details.append(msg)
                    continue

                used_keys = set()
                for m in FIG_PATTERN.finditer(content):
                    attrs = m.group(1)
                    n_figs += 1
                    cid = re.search(r'data-id="([^"]+)"', attrs)
                    typ = re.search(r'data-type="([^"]+)"', attrs)
                    lec = re.search(r'data-lecture="([^"]+)"', attrs)

                    if not (cid and lec):
                        bad_count += 1
                        msg = f"{gdir.name}/{md_file.name}: figure 锚点缺少 data-id 或 data-lecture"
                        details.append(msg)
                        continue

                    cid_val, lec_val = cid.group(1), lec.group(1)
                    typ_val = typ.group(1) if typ else "unknown"
                    used_keys.add(cid_val)
                    counts[typ_val] += 1

                    expected_lecture = f"{gid}-{md_file.stem}"
                    if lec_val != expected_lecture:
                        bad_count += 1
                        msg = f"{gdir.name}/{md_file.name}: data-lecture='{lec_val}' 不匹配（应为 '{expected_lecture}'）"
                        details.append(msg)

                    if cid_val not in data:
                        bad_count += 1
                        msg = f"{gdir.name}/{md_file.name}: figure 锚点 ID '{cid_val}' 在 JSON 中不存在"
                        details.append(msg)
                    elif typ and typ_val != data[cid_val].get("type"):
                        bad_count += 1
                        msg = f"{gdir.name}/{md_file.name}: ID '{cid_val}' 类型不匹配 md='{typ_val}' json='{data[cid_val].get('type')}'"
                        details.append(msg)

                for k, v in data.items():
                    if k not in used_keys:
                        bad_count += 1
                        msg = f"{json_name}: 键 '{k}' 未在 {gdir.name}/{md_file.name} 中引用（未闭合孤岛）"
                        details.append(msg)
                    type_by_key[v.get("type", "unknown")] += 1

        summary = {
            "pages_scanned": n_pages,
            "figures_scanned": n_figs,
            "groups_scanned": len(group_dirs),
            "figure_types": dict(counts),
            "json_types": dict(type_by_key),
            "discrepancies": bad_count,
            "issues": details
        }
        return bad_count, summary

    def export(self, dest_path: pathlib.Path) -> dict:
        """反向导出当前挂载的内容为独立内容源包"""
        state = self.load_mount_state()
        if not state:
            raise RuntimeError("当前未挂载任何内容，无法执行反向导出。")

        dest = dest_path.resolve()
        self._assert_safe_directory(dest, allow_create=True)

        source_name = state.get("source_name", "exported_content")
        export_charts_dir = dest / "charts"
        if not self.dry_run:
            dest.mkdir(parents=True, exist_ok=True)
            export_charts_dir.mkdir(parents=True, exist_ok=True)

        exported_groups = []
        exported_charts = []

        # 遍历已挂载项
        for item in state.get("mounted_items", []):
            rel_path = item.get("rel_path")
            target_path = self.target_docs / rel_path

            if not target_path.exists():
                continue

            if item.get("type") == "directory":
                # 课程组目录
                group_dest = dest / rel_path
                if not self.dry_run:
                    if group_dest.exists():
                        shutil.rmtree(group_dest)
                    shutil.copytree(str(target_path), str(group_dest))
                exported_groups.append(rel_path)
            elif item.get("type") == "file" and rel_path.startswith("public/charts/"):
                # 图表文件
                fname = pathlib.Path(rel_path).name
                chart_dest = export_charts_dir / fname
                if not self.dry_run:
                    shutil.copy2(str(target_path), str(chart_dest))
                exported_charts.append(fname)

        # 生成 content-source.json
        meta = {
            "name": source_name,
            "title": f"从引擎导出的内容包 ({source_name})",
            "version": "1.0.0",
            "exported_at": datetime.datetime.now().isoformat(),
            "groups": exported_groups,
            "charts_dir": "charts",
            "docs_dir": "."
        }

        if not self.dry_run:
            meta_file = dest / "content-source.json"
            meta_file.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

        return {
            "export_dest": str(dest),
            "groups": exported_groups,
            "charts": exported_charts,
            "meta": meta
        }


def parse_args():
    parser = argparse.ArgumentParser(
        description="开源缓冲架构内容插拔管理中枢 (Content Mount & Lifecycle Manager)"
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--mount", metavar="SOURCE", help="挂载指定内容源 (路径或 content-sources/ 预设名称)")
    group.add_argument("--unmount", action="store_true", help="卸载已挂载的内容源，恢复引擎默认示例状态")
    group.add_argument("--clean", action="store_true", help="强制清理所有非引擎自带的文件，恢复引擎初始基准")
    group.add_argument("--verify", action="store_true", help="校验已挂载讲义与 sidecar 图表的契约完整性")
    group.add_argument("--export", metavar="DEST", help="反向导出当前已挂载的内容为独立内容源包")

    parser.add_argument("--target", help="自定义目标 docs 目录路径 (默认为 site/docs)")
    parser.add_argument("--symlink", dest="symlink", action="store_true", default=True, help="优先使用符号链接/Junction (默认)")
    parser.add_argument("--copy", dest="symlink", action="store_false", help="强制使用硬拷贝模式")
    parser.add_argument("--force", action="store_true", help="强制覆盖已有的挂载状态")
    parser.add_argument("--dry-run", action="store_true", help="演练模式，仅打印操作计划而不执行改动")
    parser.add_argument("--json", action="store_true", help="以 JSON 结构化输出结果")

    return parser.parse_args()


def main():
    args = parse_args()
    script_dir = pathlib.Path(__file__).resolve().parent
    buffer_root = script_dir.parent

    target_docs = pathlib.Path(args.target).resolve() if args.target else None

    try:
        mgr = ContentMountManager(buffer_root=buffer_root, target_docs=target_docs, dry_run=args.dry_run)
    except SecurityViolationError as e:
        print(f"[SECURITY HALT] {e}", file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f"[FATAL ERROR] 初始化失败: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        if args.mount:
            result = mgr.mount(args.mount, prefer_symlink=args.symlink, force=args.force)
            if args.json:
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                print(f"[PASS] 成功挂载内容源 '{result['source_name']}'")
                print(f"  来源路径: {result['source_path']}")
                print(f"  挂载项目数: {len(result['mounted_items'])}")
                for item in result['mounted_items']:
                    print(f"    - [{item['mode']}] {item['rel_path']}")
            sys.exit(0)

        elif args.unmount:
            result = mgr.unmount(force=args.force)
            if args.json:
                print(json.dumps({"unmounted": result}, ensure_ascii=False, indent=2))
            else:
                print(f"[PASS] 成功卸载内容，共移除 {len(result)} 个挂载项目。")
            sys.exit(0)

        elif args.clean:
            result = mgr.clean()
            if args.json:
                print(json.dumps({"cleaned": result}, ensure_ascii=False, indent=2))
            else:
                print(f"[PASS] 强制清理完毕，恢复引擎初始基准状态。共移除 {len(result)} 项。")
            sys.exit(0)

        elif args.verify:
            bad_count, summary = mgr.verify()
            if args.json:
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            else:
                print("==================================================")
                print(" 讲义与 Sidecar JSON 契约双向校验报告")
                print("==================================================")
                print(f"扫描页面总数: {summary['pages_scanned']}")
                print(f"扫描课程组数: {summary['groups_scanned']}")
                print(f"图表锚点总数: {summary['figures_scanned']}")
                print(f"正文图表类型: {summary['figure_types']}")
                print(f"JSON 图表类型: {summary['json_types']}")
                print("--------------------------------------------------")
                print(f"契约不一致数: {bad_count}")
                if bad_count > 0:
                    print("\n问题清单:")
                    for issue in summary["issues"]:
                        print(f"  [X] {issue}")
                    print("\n[VERIFICATION FAILURE] 存在契约不一致！")
                    sys.exit(1)
                else:
                    print("\n[VERIFICATION PASS] 所有 figure 锚点与 JSON 双向契约 100% 严密对账！")
                    sys.exit(0)

        elif args.export:
            result = mgr.export(pathlib.Path(args.export))
            if args.json:
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                print(f"[PASS] 成功反向导出内容包至: {result['export_dest']}")
                print(f"  导出课程组: {result['groups']}")
                print(f"  导出图表数: {len(result['charts'])}")
            sys.exit(0)

    except SecurityViolationError as e:
        print(f"[SECURITY HALT] {e}", file=sys.stderr)
        sys.exit(3)
    except FileNotFoundError as e:
        print(f"[NOT FOUND] {e}", file=sys.stderr)
        sys.exit(2)
    except RuntimeError as e:
        print(f"[RUNTIME ERROR] {e}", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"[UNEXPECTED ERROR] {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
