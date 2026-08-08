# NCM 内嵌 Audio Vivid 转换设计

## 目标

让官方网易云客户端生成、解密后为 ISO BMFF/M4A 且音轨编码为 `av3a` 的 NCM 文件，可以离线转换为 MP3、WAV、FLAC 等现有音频目标格式；普通 MP3、FLAC、OGG NCM 行为保持不变。

## 已验证事实

- 三个失败样本都能完成标准 NCM 解密，解密内容以 `ftypisom` 开头。
- 三个文件的唯一音轨均为 44.1 kHz、832 kb/s、7.1.4（12 声道）的 `av3a`。
- 现有 FFmpeg 8.1.1 能识别 MP4 中的 `av3a` 标签，但没有对应音频解码器。
- 从 MP4 sample table 提取连续 `av3a` 帧后，AVS3-P3 参考解码器能输出有效 7.1.4 PCM WAV；该 WAV 可由现有 FFmpeg 下混并转换为 MP3。

## 转换链

1. `ncm-format.js` 解密 NCM，并识别 `ftyp` 为 `m4a`。
2. `av3a-format.js` 读取 `moov/trak/mdia/minf/stbl`，定位 `stsd` 中的 `av3a` 音轨。
3. 根据 `stsz`、`stsc`、`stco/co64` 提取所有音频 sample，生成临时 `.av3a` 码流。
4. 内置 AVS3-P3 helper 在其资源目录中加载 `model.bin`，输出临时 7.1.4 WAV。
5. 现有 FFmpeg 将 WAV 转换为用户目标格式；MP3 等双声道目标沿用 FFmpeg 标准下混。
6. 所有中间文件继续放在单次 NCM 临时目录，并在成功或失败后统一清理。

## 边界与错误

- M4A 中不是 `av3a` 的音轨直接交给现有 FFmpeg。
- 缺少 `moov`、sample table 不完整、sample 越界或数量不一致时停止并报告损坏的 M4A 音轨，不输出残缺音频。
- helper 或 `model.bin` 缺失时报告 Audio Vivid 解码组件缺失。
- helper 非零退出、未生成 WAV 或 WAV 为空时转换失败并清理临时文件。
- 不联网、不重新下载歌曲，不改变用户源文件。

## 资源与发布

应用资源新增 `bin/avs3/avs3RM0Decoder.exe`、`model.bin` 和对应第三方许可说明；Electron 打包将整个目录复制到 `resources/avs3`。发布前单独复核参考实现中“仅用于标准开发、测试和推广”以及不授予专利许可的条款，不把功能验证等同于商店发布授权结论。

## 验收

- 单元测试覆盖 M4A 识别、`av3a` 音轨检测、32/64 位 chunk offset、sample 提取和损坏表拒绝。
- 三个真实 NCM 均完成 NCM → AV3A → WAV → MP3，输出可由 FFmpeg 完整解码，时长与源容器一致。
- 完整 `npm test` 通过，打包资源检查确认 helper 与模型被包含。
