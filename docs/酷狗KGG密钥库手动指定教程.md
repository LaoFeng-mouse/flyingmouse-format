# 酷狗 KGG 密钥库手动指定教程

适用场景：Mahiro Format 提示「找不到酷狗密钥库（KGMusicV3.db）」，但你确定本机装了酷狗客户端、歌也是用客户端下载的。绝大多数情况会自动找到，只有酷狗把数据放到了非常规位置时才需要按本教程手动指定。

---

## 第一步：找到 KGMusicV3.db 文件

**Windows**

- 默认位置：`C:\Users\<你的用户名>\AppData\Roaming\KuGou8\KGMusicV3.db`
- 快捷打开确认：按 `Win + R`，输入 `%APPDATA%\KuGou8` 回车，能看到 `KGMusicV3.db` 就说明找对了。

**macOS**

- 打开「终端」，粘贴运行：
  `find ~/Library -name "KGMusicV3.db" 2>/dev/null`
- 记下输出的完整路径（形如 `~/Library/Application Support/KuGou/KGMusicV3.db`）。

---

## 第二步：设置环境变量 FLYINGMOUSE_KGG_DB_PATH

**Windows（二选一）**

方式一（图形界面）：
1. `Win + R`，输入 `sysdm.cpl` 回车；
2. 点「高级」标签 → 「环境变量」；
3. 「用户变量」区域点「新建」；
4. 变量名填 `FLYINGMOUSE_KGG_DB_PATH`，变量值填第一步的完整路径；
5. 一路点「确定」关闭。

方式二（命令行）：
1. `Win + R`，输入 `cmd` 回车；
2. 粘贴运行（把路径换成你自己的）：
   `setx FLYINGMOUSE_KGG_DB_PATH "C:\Users\<用户名>\AppData\Roaming\KuGou8\KGMusicV3.db"`

**macOS**

- 终端粘贴运行（把路径换成你自己的）：
  `launchctl setenv FLYINGMOUSE_KGG_DB_PATH "/Users/<用户名>/Library/Application Support/KuGou/KGMusicV3.db"`
- 若想永久生效，可把 `export FLYINGMOUSE_KGG_DB_PATH="..."` 追加到 `~/.zshenv`，注销重登后生效。

---

## 第三步：重启 Mahiro Format

1. 完全退出 Mahiro Format（右下角托盘图标右键「退出」，别只关窗口）；
2. 重新打开 Mahiro Format，再转一次。

> Windows 上如果重启软件后仍提示找不到，注销重登（或重启电脑）后再试——环境变量对新启动的程序生效需要刷新一次系统会话。

> KGG 兼容属于不稳定的实验性功能。请保留源文件并复核转换结果；仅处理你合法取得且有权使用的文件。

---

## 补充说明

- 这个环境变量只影响「酷狗 KGG 解密」这一个功能，其它格式转换不受影响。
- 解密密钥存在本机酷狗客户端的数据目录里，**不跨设备/系统同步**：如果这首歌是在别的电脑（或 Mac/手机）下载的，本机没有密钥，手动指定路径也解不了，得在本机酷狗客户端重新下载这首歌。

原作者：牢蜂（LaoFeng）。Mahiro Format 升级与维护：YKZStudio。
