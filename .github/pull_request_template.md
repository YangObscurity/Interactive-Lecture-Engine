# Pull Request

## 做了什么

<!-- 一两句话；修 bug 的话写清楚修的是什么 -->

关联 issue：<!-- 例如 Closes #123 -->

## 改动类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `docs` 文档
- [ ] `refactor` 重构（外部行为不变）
- [ ] `test` 测试
- [ ] `chore` 构建、依赖、配置

## 改动范围

- [ ] 站点主题或组件（`site/docs/.vitepress/`）
- [ ] 构建、检查脚本（`site/scripts/`、`scripts/`）
- [ ] 后端（`server/`）
- [ ] 内容模板或示例内容
- [ ] CI
- [ ] 文档

## 验证

<!-- 贴实际跑过的命令和输出，不要只写“已测试” -->

```
cd site && npm run check && npm run build
```

<!-- 动了界面：npm run test:e2e 的结果；动了后端：cd server && npm test 的结果 -->

## 检查

- [ ] 没有提交讲义内容、个人信息、主机名或密钥（隐私扫描通过）
- [ ] 界面文字有中英文
- [ ] 需要的话更新了 `docs-dev/` 说明
