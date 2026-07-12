# 百度网盘批量转存助手

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](dist/chromium/manifest.json)
[![GitHub release](https://img.shields.io/github/v/release/kola-official/baidu-transfer-helper)](https://github.com/kola-official/baidu-transfer-helper/releases)

一个完全开源、无第三方服务器的百度网盘批量转存工具。当非会员遇到单次文件数量限制时，工具会递归展开超大目录并自动分批转存。

同时提供：

- Chrome、Edge、Brave、360 等 Chromium 浏览器扩展；
- Firefox 扩展；
- Tampermonkey / Violentmonkey 油猴脚本。

## 功能

- 识别 `pan.baidu.com/s/1...` 和 `share/init?surl=...` 分享链接；
- 支持带提取码的分享；
- 文件自动按每批 100 个转存；
- 超大目录自动递归展开、拆分并转存；
- 支持保存到根目录或自定义目录，例如 `/学习资料/2026`；
- 百度接口限流时自动延迟重试，并设有重试上限；
- 转存进度和表单只保存在浏览器本地；
- 不收集、不上传分享链接、提取码、Cookie 或网盘文件信息；
- 不使用任何第三方服务端。

## 下载

建议从 [GitHub Releases](https://github.com/kola-official/baidu-transfer-helper/releases/latest) 下载最新版本：

| 平台 | 下载文件 |
|---|---|
| Chrome / Edge / Chromium | `baidu-transfer-helper-chromium.zip` |
| Firefox | `baidu-transfer-helper-firefox.xpi` |
| Tampermonkey / Violentmonkey | `baidu-transfer-helper.user.js` |

仓库的 `dist/` 目录也包含最新构建产物。

## 安装方法

### 方法一：油猴脚本（推荐）

油猴版无需开启浏览器开发者模式，同时兼容 Chrome、Edge 和 Firefox。

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)；
2. 从 Releases 下载 `baidu-transfer-helper.user.js`；
3. 在脚本管理器中选择“添加新脚本”或“从文件导入”；
4. 导入脚本并确认安装；
5. 登录 [百度网盘](https://pan.baidu.com/) 并刷新页面；
6. 页面右下角出现“批存”按钮即表示安装成功。

> 油猴版运行在百度网盘页面中，任务完成前不要关闭或刷新该标签页。

### 方法二：Chrome / Edge / Chromium 扩展

1. 从 Releases 下载 `baidu-transfer-helper-chromium.zip` 并解压；
2. Chrome 打开 `chrome://extensions/`；Edge 打开 `edge://extensions/`；
3. 开启页面右上角的“开发者模式”；
4. 点击“加载已解压的扩展程序”；
5. 选择解压后的扩展目录；
6. 登录百度网盘，然后点击浏览器工具栏中的扩展图标。

也可以直接克隆仓库后加载 `dist/chromium/` 目录。

### 方法三：Firefox 扩展

临时安装：

1. 下载 `baidu-transfer-helper-firefox.xpi`，或克隆本仓库；
2. 打开 `about:debugging#/runtime/this-firefox`；
3. 点击“临时载入附加组件”；
4. 选择 XPI，或选择仓库中的 `dist/firefox/manifest.json`。

Firefox 临时扩展会在浏览器重启后被移除。长期安装需要由 Mozilla AMO 签名。

## 使用方法

1. 在当前浏览器中登录百度网盘；
2. 打开扩展弹窗或页面右下角的“批存”面板；
3. 粘贴百度网盘分享链接；
4. 如果分享有提取码，填写提取码；
5. 保存目录留空或填写 `/` 表示保存到网盘根目录；也可以填写 `/资料/2026`；
6. 点击“开始转存”；
7. 等待状态显示“全部转存完成”；
8. 刷新百度网盘文件列表查看结果。

请勿在多个页面或多个扩展实例中同时启动相同任务，以免重复转存。

## 从源码构建

需要 Node.js 18 或更高版本。项目没有 npm 运行时依赖。

```bash
git clone https://github.com/kola-official/baidu-transfer-helper.git
cd baidu-transfer-helper
npm run check
```

`npm run check` 会执行单元测试，并生成：

```text
dist/chromium/
dist/firefox/
dist/userscript/baidu-transfer-helper.user.js
```

生成可提交浏览器商店或签名服务的 ZIP、XPI 和 SHA-256 校验值：

```bash
npm run package
```

## 项目结构

```text
src/core.js          百度网盘接口、目录递归和批量转存核心
src/background.js    浏览器扩展后台任务
src/popup.*          浏览器扩展界面
src/userscript.js    油猴脚本界面与入口
scripts/build.mjs    三端构建脚本
scripts/package.sh   发布包与校验值生成脚本
tests/               核心逻辑单元测试
dist/                可直接安装的构建产物
```

## 参考来源与致谢

本项目的需求和功能思路参考了 Microsoft Edge 扩展商店中的：

- **百度网盘文件转存助手**
- 原扩展作者：`shimmer00000000007`（以商店 Manifest 信息为准）
- 原扩展地址：[Microsoft Edge Add-ons – 百度网盘文件转存助手](https://microsoftedge.microsoft.com/addons/detail/%E7%99%BE%E5%BA%A6%E7%BD%91%E7%9B%98%E6%96%87%E4%BB%B6%E8%BD%AC%E5%AD%98%E5%8A%A9%E6%89%8B/giimanbhbckkmciocichidocaophhmjg?hl=zh-CN)

本仓库是为实现多浏览器兼容、油猴支持和公开维护而编写的**独立开源实现**，没有直接分发原商店扩展的 CRX、图标或压缩包。感谢原作者提供的产品思路。

## 隐私与安全

- 所有请求直接发送到 `https://pan.baidu.com`；
- 不包含统计、广告、远程代码或第三方 API；
- 不读取浏览器密码；
- 扩展仅申请百度网盘域名、Cookie、扩展存储和请求头规则所需权限；
- 源码和构建脚本全部公开，可以自行审查和构建。

## 注意事项

- 本项目是非官方工具，与百度及原 Edge 扩展作者无隶属或合作关系；
- 百度网盘页面/API 调整后，工具可能需要同步更新；
- 请只转存你有权访问、保存和使用的内容；
- 使用本工具时请遵守百度网盘服务条款及当地法律法规。

## 开源协议

本项目以 [MIT License](LICENSE) 完全开源。

你可以自由使用、复制、修改、合并、发布、分发、再许可和商业使用，但需要保留原版权声明和 MIT 许可文本。软件按“原样”提供，不附带任何明示或暗示担保。

欢迎提交 Issue 和 Pull Request。
