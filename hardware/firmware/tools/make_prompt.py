#!/usr/bin/env python3
"""把一段语音（mp3/wav 都行）转成固件里的提示音 src/prompt_pcm.h：16 kHz 单声道 int16。
用法：python3 tools/make_prompt.py 提示语.mp3
默认那句「未连接参谋电报机。请在电脑上打开参谋电报机软件。」是用参谋的 Fish 音色合成的。"""
import os, subprocess, sys

src = sys.argv[1]
raw = subprocess.run(
    ['ffmpeg', '-loglevel', 'error', '-i', src,
     # 去掉首尾静音、响度统一，免得在小喇叭上忽大忽小
     '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5',
     '-ar', '16000', '-ac', '1', '-f', 's16le', '-'],
    check=True, capture_output=True).stdout
n = len(raw) // 2
vals = [int.from_bytes(raw[i * 2:i * 2 + 2], 'little', signed=True) for i in range(n)]
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'prompt_pcm.h')
with open(out, 'w') as f:
    f.write('// 没连上参谋软件时从喇叭播的提示语（tools/make_prompt.py 生成，%.1f 秒，16 kHz 单声道）\n' % (n / 16000))
    f.write('#pragma once\n#include <stdint.h>\n#include <stddef.h>\n\n')
    f.write('static const int16_t PROMPT_PCM[] = {\n')
    for i in range(0, n, 16):
        f.write('  ' + ', '.join(str(v) for v in vals[i:i + 16]) + ',\n')
    f.write('};\nstatic const size_t PROMPT_PCM_LEN = sizeof(PROMPT_PCM) / sizeof(PROMPT_PCM[0]);\n')
print('写好 %s：%d 个采样，%.1f 秒' % (os.path.normpath(out), n, n / 16000))
