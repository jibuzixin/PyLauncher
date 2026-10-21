#!/bin/bash
# 测试用假浏览器：代替 webbrowser.open，把"开了一个标签页"记一行日志
echo "$@" >> "$FAKE_BROWSER_LOG"
