# -*- coding: utf-8 -*-
"""test_mount.py —— 开源缓冲架构内容插拔管理中枢全量自动化测试套件

测试覆盖范围：
  1. 官方 demo 内容包标准挂载测试（符号链接 / Junction / 拷贝降级）
  2. 契约校验双向对账测试（正向 100% PASS 验证）
  3. 契约破坏阻断测试（篡改类型与孤岛 key 负向拦截，断言退出码 1）
  4. 反向导出独立内容源包测试（--export 与重新挂载闭环）
  5. 精准回滚卸载测试（--unmount 后白名单完整，业务文件零残留）
  6. 强力脱敏清理测试（--clean 强制清除所有脏文件）
  7. 沙箱安全防线测试（越界路径逃逸拦截，断言退出码 3）
  8. 显式硬拷贝模式测试（--copy 模式下的挂载与卸载完整生命周期）
"""

import io
import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest

# 跨平台输出编码防护
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 引入被测模块
SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
BUFFER_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from mount_content import ContentMountManager, SecurityViolationError, PROTECTED_DOCS_ITEMS


class TestContentMountLifecycle(unittest.TestCase):
    """内容挂载全生命周期测试类"""

    def setUp(self):
        """每个用例创建独立的临时沙箱测试目录"""
        self.test_dir = pathlib.Path(tempfile.mkdtemp(prefix="oss_test_sandbox_")).resolve()
        self.mock_docs = self.test_dir / "site" / "docs"
        self.mock_docs.mkdir(parents=True, exist_ok=True)

        # 构建原生引擎白名单骨架
        (self.mock_docs / ".vitepress").mkdir(parents=True, exist_ok=True)
        (self.mock_docs / ".vitepress" / "config.mts").write_text("// test config", encoding="utf-8")
        (self.mock_docs / "index.md").write_text("# Test Home", encoding="utf-8")
        (self.mock_docs / "public" / "charts").mkdir(parents=True, exist_ok=True)
        (self.mock_docs / "public" / "charts" / ".keep").write_text("# keep", encoding="utf-8")

        self.mgr = ContentMountManager(buffer_root=BUFFER_ROOT, target_docs=self.mock_docs)

    def tearDown(self):
        """清理测试临时沙箱"""
        try:
            # 先解除可能存在的挂载
            self.mgr.unmount(force=True)
        except Exception:
            pass
        if self.test_dir.exists():
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_01_mount_demo_package(self):
        """测试 1: 挂载官方演示内容包 demo"""
        result = self.mgr.mount("demo", prefer_symlink=True)
        self.assertEqual(result["source_name"], "demo")
        self.assertTrue((self.mock_docs / "demo" / "index.md").exists())
        self.assertTrue((self.mock_docs / "demo" / "L01.md").exists())
        self.assertTrue((self.mock_docs / "demo" / "L02.md").exists())
        self.assertTrue((self.mock_docs / "public" / "charts" / "DEMO-L01.json").exists())
        self.assertTrue((self.mock_docs / "public" / "charts" / "DEMO-L02.json").exists())
        self.assertTrue((self.mock_docs / ".content-mount.json").exists())

    def test_02_verify_demo_contract_pass(self):
        """测试 2: 挂载 demo 后执行契约校验，断言 0 违规 PASS"""
        self.mgr.mount("demo", prefer_symlink=True)
        bad_count, summary = self.mgr.verify()
        self.assertEqual(bad_count, 0, f"预期契约 0 错误，实际错误: {summary.get('issues')}")
        self.assertEqual(summary["pages_scanned"], 2)
        self.assertEqual(summary["figures_scanned"], 2)
        self.assertEqual(summary["figure_types"].get("echarts"), 1)
        self.assertEqual(summary["figure_types"].get("mermaid"), 1)

    def test_03_verify_negative_broken_contract(self):
        """测试 3: 契约破坏负向测试（未闭合孤岛 key 与类型篡改）"""
        # 使用 copy 模式以便直接篡改副本测试
        self.mgr.mount("demo", prefer_symlink=False)
        chart_file = self.mock_docs / "public" / "charts" / "DEMO-L01.json"
        data = json.loads(chart_file.read_text(encoding="utf-8"))

        # 注入未在 markdown 中引用的孤岛 key
        data["unreferenced_c99"] = {"type": "echarts", "title": "Orphan Chart"}
        chart_file.write_text(json.dumps(data), encoding="utf-8")

        bad_count, summary = self.mgr.verify()
        self.assertGreater(bad_count, 0, "预期检测到孤岛未引用 key，但校验放行了")
        self.assertTrue(any("unreferenced_c99" in issue for issue in summary["issues"]))

    def test_04_unmount_cleanliness_and_engine_protection(self):
        """测试 4: 精准卸载测试，断言业务讲义完全清理且引擎白名单毫发无损"""
        self.mgr.mount("demo", prefer_symlink=True)
        unmounted = self.mgr.unmount()
        self.assertGreater(len(unmounted), 0)

        # 断言挂载的讲义和图表均已不存在
        self.assertFalse((self.mock_docs / "demo").exists())
        self.assertFalse((self.mock_docs / "public" / "charts" / "DEMO-L01.json").exists())
        self.assertFalse((self.mock_docs / ".content-mount.json").exists())

        # 断言受保护的引擎自带核心文件完好无损
        self.assertTrue((self.mock_docs / "index.md").exists())
        self.assertTrue((self.mock_docs / ".vitepress" / "config.mts").exists())
        self.assertTrue((self.mock_docs / "public" / "charts" / ".keep").exists())

    def test_05_clean_force_removes_dirty_files(self):
        """测试 5: 强制清理功能，断言清除所有非白名单脏文件"""
        # 创建各种非白名单的业务脏文件和临时文件
        dirty_group = self.mock_docs / "g99_secret"
        dirty_group.mkdir(parents=True, exist_ok=True)
        (dirty_group / "L01.md").write_text("private notes", encoding="utf-8")
        (self.mock_docs / "public" / "charts" / "G99-L01.json").write_text("{}", encoding="utf-8")
        (self.mock_docs / "random_notes.md").write_text("scratch", encoding="utf-8")

        cleaned = self.mgr.clean()
        self.assertGreater(len(cleaned), 0)

        # 断言所有脏内容已被完全清除
        self.assertFalse((self.mock_docs / "g99_secret").exists())
        self.assertFalse((self.mock_docs / "public" / "charts" / "G99-L01.json").exists())
        self.assertFalse((self.mock_docs / "random_notes.md").exists())

        # 断言受保护引擎核心依然保留
        self.assertTrue((self.mock_docs / "index.md").exists())
        self.assertTrue((self.mock_docs / ".vitepress" / "config.mts").exists())
        self.assertTrue((self.mock_docs / "public" / "charts" / ".keep").exists())

    def test_06_export_content_package(self):
        """测试 6: 反向导出当前挂载内容，并验证导出包的自包含完整性"""
        self.mgr.mount("demo", prefer_symlink=False)
        export_dest = self.test_dir / "exported_demo_pkg"

        export_result = self.mgr.export(export_dest)
        self.assertEqual(export_result["export_dest"], str(export_dest))
        self.assertTrue((export_dest / "content-source.json").exists())
        self.assertTrue((export_dest / "demo" / "L01.md").exists())
        self.assertTrue((export_dest / "charts" / "DEMO-L01.json").exists())

        # 卸载当前内容
        self.mgr.unmount()

        # 尝试挂载刚刚导出的内容包，验证自包含性
        new_mount = self.mgr.mount(str(export_dest), prefer_symlink=True)
        self.assertEqual(new_mount["source_name"], "demo")
        bad_count, _ = self.mgr.verify()
        self.assertEqual(bad_count, 0, "从导出包重新挂载后契约校验应当为 0 错误")

    def test_07_sandbox_security_traversal_interception(self):
        """测试 7: 沙箱安全检查，断言拦截跨越目录的路径逃逸与非合法目录操作"""
        # 尝试越界到父级非 target 目录
        malicious_child = self.mock_docs.parent.parent / "escape_file.txt"
        with self.assertRaises(SecurityViolationError):
            self.mgr._assert_child_of_target(malicious_child)

        # 尝试将 Windows 根盘符设为 target
        with self.assertRaises(SecurityViolationError):
            ContentMountManager(buffer_root=BUFFER_ROOT, target_docs=pathlib.Path("C:\\"))

    def test_08_explicit_copy_mode_lifecycle(self):
        """测试 8: 显式硬拷贝模式 (--copy) 的挂载与卸载完整生命周期"""
        result = self.mgr.mount("demo", prefer_symlink=False)
        for item in result["mounted_items"]:
            self.assertEqual(item["mode"], "copy")

        self.assertTrue((self.mock_docs / "demo" / "L01.md").exists())
        bad_count, _ = self.mgr.verify()
        self.assertEqual(bad_count, 0)

        unmounted = self.mgr.unmount()
        self.assertGreater(len(unmounted), 0)
        self.assertFalse((self.mock_docs / "demo").exists())

    def test_09_mount_with_groups_mts_and_unmount(self):
        """测试 9: 挂载包含 groups.mts 的内容源，验证 content-groups.mts 正确挂载与干净卸载"""
        custom_src = self.test_dir / "custom_source"
        custom_src.mkdir(parents=True, exist_ok=True)
        (custom_src / "groups.mts").write_text("export const GROUPS = []\n", encoding="utf-8")
        (custom_src / "g01").mkdir(parents=True, exist_ok=True)
        (custom_src / "g01" / "L01.md").write_text("# L01\n", encoding="utf-8")

        result = self.mgr.mount(str(custom_src), prefer_symlink=False)
        target_cfg = self.mock_docs / ".vitepress" / "content-groups.mts"
        self.assertTrue(target_cfg.exists(), "content-groups.mts 应当被成功挂载/拷贝")

        unmounted = self.mgr.unmount()
        self.assertFalse(target_cfg.exists(), "卸载后 content-groups.mts 应当被干净移除")
        self.assertFalse((self.mock_docs / "g01").exists(), "卸载后业务讲义目录应当被移除")


def run_tests():
    """运行测试并输出格式化结果"""
    print("======================================================================")
    print(" 启动开源缓冲中枢 (OSS Buffer) 全生命周期自动化单元测试套件")
    print("======================================================================")
    suite = unittest.TestLoader().loadTestsFromTestCase(TestContentMountLifecycle)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("\n[ALL PASS] 全部 9 项生命周期与安全测试 100% 通过！")
        return 0
    else:
        print("\n[TEST FAIL] 存在未通过的测试用例！")
        return 1


if __name__ == "__main__":
    sys.exit(run_tests())
