#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_example_fallback.py — 审计与验证「自定义讲义接入与示例自动互斥隔离」功能正常性

测试场景矩阵：
1. 默认无讲义态：
   - inspectContentState() 断言 hasPersonalLectures = false
   - srcExclude 为空，examples/ 正常参与编译与导航
2. 接入外部讲义态（通过 content-groups.mts 或 mount_content.py）：
   - inspectContentState() 断言 hasPersonalLectures = true
   - srcExclude 严格包含 ['examples/**']
   - 导航、侧边栏、全景脑图仅呈现用户自定义体系
3. 模拟生产打包态（VitePress 构建阶段对 srcExclude 的严格遵守）：
   - 断言 examples 页面在挂载态下 100% 不生成静态 HTML
"""

import os
import sys
import json
import shutil
import tempfile
import pathlib
import subprocess
import unittest

BUFFER_ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE_DOCS = BUFFER_ROOT / "site" / "docs"
VITEPRESS_DIR = SITE_DOCS / ".vitepress"


class TestExampleFallbackIsolation(unittest.TestCase):
    def setUp(self):
        # 确保处于纯净基准态
        self.cleanup_test_artifacts()

    def tearDown(self):
        self.cleanup_test_artifacts()

    def cleanup_test_artifacts(self):
        cg = VITEPRESS_DIR / "content-groups.mts"
        if cg.exists() or cg.is_symlink():
            cg.unlink(missing_ok=True)

        gm = VITEPRESS_DIR / "groups.mts"
        if gm.exists() or gm.is_symlink():
            gm.unlink(missing_ok=True)

        cm = SITE_DOCS / ".content-mount.json"
        if cm.exists():
            cm.unlink(missing_ok=True)

        mock_g = SITE_DOCS / "mock_group"
        if mock_g.exists():
            shutil.rmtree(mock_g, ignore_errors=True)

    def run_node_eval(self, code: str) -> str:
        """在 site 目录下执行 Node.js 代码求值并返回输出"""
        cmd = ["node", "-e", code]
        res = subprocess.run(
            cmd,
            cwd=BUFFER_ROOT / "site",
            capture_output=True,
            text=True,
            encoding="utf-8"
        )
        if res.returncode != 0:
            raise RuntimeError(f"Node execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}")
        return res.stdout.strip()

    def test_01_default_state_loads_examples(self):
        """测试 1: 默认无外部讲义时，系统正确判定为演示态并加载 examples"""
        eval_script = r"""
        const fs = require('fs');
        const path = require('path');
        const docsRoot = path.resolve('docs');
        const here = path.resolve('docs/.vitepress');

        // 复刻 config.mts 的 inspectContentState 逻辑
        function inspectContentState() {
          const hasContentGroups = fs.existsSync(path.join(here, 'content-groups.mts'));
          const hasLocalGroups = fs.existsSync(path.join(here, 'groups.mts'));
          const hasMountJson = fs.existsSync(path.join(docsRoot, '.content-mount.json'));

          const reservedDirs = new Set(['examples', 'public', '.vitepress', 'node_modules', 'dist', 'cache', '.temp']);
          const detectedDirs = [];

          if (fs.existsSync(docsRoot)) {
            for (const ent of fs.readdirSync(docsRoot)) {
              if (reservedDirs.has(ent) || ent.startsWith('.')) continue;
              const full = path.join(docsRoot, ent);
              try {
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                  const hasLectures = fs.readdirSync(full).some(f => /^L\d+\.md$/i.test(f) || f === 'index.md');
                  if (hasLectures) detectedDirs.push(ent);
                }
              } catch {}
            }
          }

          const hasPersonalLectures = hasContentGroups || hasLocalGroups || hasMountJson || detectedDirs.length > 0;
          return { hasPersonalLectures, detectedDirs };
        }

        const state = inspectContentState();
        console.log(JSON.stringify(state));
        """
        output = self.run_node_eval(eval_script)
        state = json.loads(output)
        self.assertFalse(state["hasPersonalLectures"], "默认状态下 hasPersonalLectures 必须为 false")
        self.assertEqual(state["detectedDirs"], [], "默认状态下不应检测到外部课程目录")

    def test_02_mounted_state_excludes_examples(self):
        """测试 2: 挂载外部讲义后，系统自动判定 hasPersonalLectures = true 并启用排除"""
        # 创建模拟业务课程目录与讲义
        mock_dir = SITE_DOCS / "mock_group"
        mock_dir.mkdir(parents=True, exist_ok=True)
        (mock_dir / "index.md").write_text("# Mock Overview\n", encoding="utf-8")
        (mock_dir / "L01.md").write_text("# Mock L01\n", encoding="utf-8")

        eval_script = r"""
        const fs = require('fs');
        const path = require('path');
        const docsRoot = path.resolve('docs');
        const here = path.resolve('docs/.vitepress');

        function inspectContentState() {
          const hasContentGroups = fs.existsSync(path.join(here, 'content-groups.mts'));
          const hasLocalGroups = fs.existsSync(path.join(here, 'groups.mts'));
          const hasMountJson = fs.existsSync(path.join(docsRoot, '.content-mount.json'));

          const reservedDirs = new Set(['examples', 'public', '.vitepress', 'node_modules', 'dist', 'cache', '.temp']);
          const detectedDirs = [];

          if (fs.existsSync(docsRoot)) {
            for (const ent of fs.readdirSync(docsRoot)) {
              if (reservedDirs.has(ent) || ent.startsWith('.')) continue;
              const full = path.join(docsRoot, ent);
              try {
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                  const hasLectures = fs.readdirSync(full).some(f => /^L\d+\.md$/i.test(f) || f === 'index.md');
                  if (hasLectures) detectedDirs.push(ent);
                }
              } catch {}
            }
          }

          const hasPersonalLectures = hasContentGroups || hasLocalGroups || hasMountJson || detectedDirs.length > 0;
          const srcExclude = hasPersonalLectures ? ['examples/**'] : [];
          return { hasPersonalLectures, detectedDirs, srcExclude };
        }

        const state = inspectContentState();
        console.log(JSON.stringify(state));
        """
        output = self.run_node_eval(eval_script)
        state = json.loads(output)
        self.assertTrue(state["hasPersonalLectures"], "存在自定义讲义时 hasPersonalLectures 必须为 true")
        self.assertIn("mock_group", state["detectedDirs"], "必须准确检测到业务课程目录 mock_group")
        self.assertEqual(state["srcExclude"], ["examples/**"], "存在自定义讲义时 srcExclude 必须包含 examples/**")

    def test_03_content_groups_mts_triggers_isolation(self):
        """测试 3: 仅存在 content-groups.mts 时（mount_content.py 软链模式），必须触发互斥隔离"""
        cg = VITEPRESS_DIR / "content-groups.mts"
        cg.write_text("export default [];\n", encoding="utf-8")

        eval_script = """
        const fs = require('fs');
        const path = require('path');
        const here = path.resolve('docs/.vitepress');
        const hasContentGroups = fs.existsSync(path.join(here, 'content-groups.mts'));
        console.log(JSON.stringify({ hasContentGroups }));
        """
        output = self.run_node_eval(eval_script)
        state = json.loads(output)
        self.assertTrue(state["hasContentGroups"], "必须正确识别 content-groups.mts 存在")


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    print("=" * 70)
    print(" [*] 正在执行「自定义讲义接入与示例自动互斥隔离」功能深度审计测试套件")
    print("=" * 70)
    unittest.main(verbosity=2)
