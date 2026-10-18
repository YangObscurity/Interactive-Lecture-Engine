# assets — 站点静态资产备份

| 文件 | 用途 |
|---|---|
| `favicon.svg` | **主图标**（菱形标记，300×300 矢量） |
| `favicon.ico` | 16/32/48/64 多尺寸兜底 |
| `icon-192.png` | PWA / 安卓 |
| `apple-touch-icon.png` | iOS 添加到主屏 |

## 为什么在这里存一份

站点源码（`site/` 镜像对应的真实工作副本）此前**不在任何 git 仓库里**，而图标源文件来自
一个**仓库之外的**素材目录（即时通讯软件接收目录下的 logo 素材包；此处不记具体路径，
因为它是私人本机路径）—— 两处都可能丢失。这里留一份成品，
配合生成器 `scripts/make_site_icon.py` 可以随时重建。

## 重新生成

```bash
python scripts/make_site_icon.py --src <logo 素材包目录>
```

> `--src` 为**必填**：logo 源包属外部素材、不随仓库发布，故脚本不内置默认路径；
> 该目录须含 `vector/default.svg` 与 `default.png`。
> 输出目录默认 = 本仓库的 `site/docs/public/`，可用 `--pub` 覆盖。

脚本会从源 logo 包的 `vector/default.svg`（纯标记）与 `default.png`（标记 + 品牌文字）
生成上面四个文件并写入 `site/docs/public/`。

**踩过的坑**：从 `default.png` 裁 `favicon.ico` 时**不能按固定比例取左半** ——
那会把右侧的品牌文字一起圈进来。要**按列扫描找第一个连续墨迹簇**才是标记本体。

部署到站点后，`config.mts` 的 `head` 必须显式声明（见 `ops/README.md` §5），
否则浏览器会盲请求 `/favicon.ico`（虽然文件在，但声明后才不会有多余请求与告警）。
