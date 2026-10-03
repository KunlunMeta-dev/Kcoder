KCoder Studio Remote（Windows x64 开发验收版）

使用方法：
1. 在 Windows 上确认浏览器能够访问部署的 Studio Web 地址（例如 http://<server>:4174/）。
2. 完整解压 ZIP；不要只把 EXE 单独复制出来。
3. 使用下面的命令或环境变量配置地址和访问令牌后启动。安装包不携带默认令牌，缺少令牌会明确报错。
4. 本包未进行 Windows 代码签名。如果 SmartScreen 提示未知发布者，请核对下载来源和 SHA-256，
   然后选择“更多信息”→“仍要运行”。

连接其他服务：
  .\kcoder-studio-remote.exe --server-url=http://服务器地址:端口 --token=访问令牌

说明：
- 这是远程薄客户端，不会在 Windows 本地启动 kcoder 或修改远端服务器配置。
- 可使用 KCODER_STUDIO_REMOTE_URL 和 KCODER_STUDIO_REMOTE_TOKEN 环境变量，避免把令牌写在快捷方式中。
- 当前包需要 Windows 10/11 x64。
