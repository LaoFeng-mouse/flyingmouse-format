# 飞鼠格式 Electron 安全加固设计

## 背景

当前桌面程序以 Electron 33.4.11 加载绑定在 `127.0.0.1` 随机端口上的 Express 页面。窗口已启用 `contextIsolation` 并关闭 `nodeIntegration`，但主进程没有限制顶层导航、外部协议、IPC 调用来源或下载 URL；渲染器还使用 `innerHTML` 拼接部分动态内容。打包产物未签名，桌面快捷方式直接指向 `dist\win-unpacked`。

本次只加固现有架构，不重构转换能力，不改 UI 视觉，不引入远程服务。

## 目标

- 将 Electron 升级到当前稳定版 43。
- 仅允许窗口和 IPC 信任本次启动的本地服务源。
- 仅允许保存本地服务生成的下载资源。
- 仅允许通过系统浏览器打开明确的 HTTPS 地址。
- 增加严格 CSP，并移除动态列表中的 HTML 字符串注入面。
- 保持现有单文件、批量转换、保存对话框和离线运行行为。
- 重新生成未签名 NSIS 与 `win-unpacked` 产物，并记录代码签名接入方式。

## 非目标

- 不购买、生成或导入代码签名证书。
- 不把 Express 服务改成自定义 Electron 协议。
- 不修改转换格式、转换算法、鼠鼠视觉或产品文案。
- 不自动替换桌面快捷方式；打包验证通过后再单独确认是否切换目标。

## 架构

新增 `electron-security.js` 作为纯函数安全策略模块，负责解析和判断 URL，不依赖 Electron，便于直接单元测试。`electron-main.js` 保存服务启动后的可信 origin，并在导航、外链和 IPC 边界调用这些策略。

可信页面定义为与 `serverUrl` 完全相同的 origin。可信下载还必须满足同源、无用户名密码、且路径精确匹配 `/downloads/<非空标识>`，不接受重定向到其他 origin。外部打开只允许无用户名密码的 `https:` URL。

## 主进程行为

### BrowserWindow

- 保留 `contextIsolation: true` 和 `nodeIntegration: false`。
- 显式设置 `sandbox: true`。
- 注册 `will-navigate`；仅允许可信本地 origin，其他导航全部阻止。
- `setWindowOpenHandler` 始终拒绝创建 Electron 子窗口；只有通过外链策略的 HTTPS URL 才交给 `shell.openExternal`。

### IPC

`save-converted-file` 和 `save-converted-files` 在打开任何对话框或发起下载前完成以下校验：

1. `event.senderFrame.url` 属于可信本地 origin。
2. 文件名继续使用 `path.basename` 收敛为文件名。
3. 下载 URL 属于可信本地 origin，并匹配 `/downloads/<id>`。
4. 批量保存逐项校验；任一项非法时整批拒绝，不产生部分写入。

校验失败时抛出固定中文错误，不回显攻击者提供的完整 URL。

### 下载

下载函数只接受已验证的本地下载 URL。若服务返回重定向，重定向目标必须再次通过相同下载策略，否则终止。临时输出仍由现有 Express 服务管理。

## 渲染器与 CSP

Express 为页面响应增加 CSP：

`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`

批量文件列表改用 `document.createElement` 和 `textContent` 创建节点。能力表只使用服务器内部常量，但也一并改用安全 DOM 构建，避免未来数据来源变化后重新形成注入面。固定的 `<option>` 占位文本统一改为 DOM API，不再向 `innerHTML` 赋值。

## Electron 升级与打包

- 将 `devDependencies.electron` 更新到兼容 Electron 43 的版本并刷新锁文件。
- 保持 `electron-builder`、NSIS、离线工具 `extraResources` 和 `signAndEditExecutable: false` 不变。
- README 增加正式分发签名说明：通过环境或安全 CI 注入证书，不在仓库保存证书、密码或令牌。
- 本次生成的 EXE 仍会显示未签名，这是已知限制而不是完成代码签名。

## 测试策略

采用测试驱动开发：

1. 先为安全策略写失败测试，覆盖同源页面、异源页面、危险协议、凭据型 URL、合法下载路径、伪造相似路径和跨源重定向。
2. 再实现最小纯函数使测试通过。
3. 为主进程源码增加结构回归测试，确认 `sandbox`、`will-navigate`、IPC sender 校验和安全外链调用存在。
4. 为渲染器增加回归测试，确认动态文件名和错误详情不再进入 `innerHTML` 模板。
5. 运行全部现有转换测试与语法检查。
6. 执行正式打包，核对新 `win-unpacked` EXE 的版本、哈希、签名状态和快捷方式当前状态。

## 错误处理

- 非法导航静默阻止并写入现有调试日志，不加载目标页面。
- 非法外链不调用操作系统，只记录被拒绝的协议和主机，不记录查询参数。
- 非法 IPC 或下载请求向渲染器返回固定错误，保存对话框不出现。
- Electron 升级或打包不兼容视为阻塞，不覆盖现有桌面快捷方式。

## 验收标准

- 新增安全测试经历可证明的红灯到绿灯过程。
- 所有语法检查和完整测试套件通过。
- Electron 43 能成功打包为 NSIS 和 `win-unpacked`。
- 打包程序静态元数据符合预期，且现有转换测试没有回归。
- README 明确区分未签名开发构建与正式签名分发。
- 未经用户额外确认，不修改 `C:\Users\34615\Desktop\飞鼠格式.lnk`。
