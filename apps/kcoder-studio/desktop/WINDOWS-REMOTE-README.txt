KCoder Studio Remote（Windows x64 开发验收版）

使用方法：
1. 在 Windows 上确认浏览器能够访问部署的 Studio Web 地址（例如 http://<server>:4174/）。
2. 完整解压 ZIP；不要只把 EXE 单独复制出来。
3. 双击 kcoder-studio-remote.exe。客户端会自动连接上述地址并使用开发令牌 123 登录。
4. 本包未进行 Windows 代码签名。如果 SmartScreen 提示未知发布者，请核对下载来源和 SHA-256，
   然后选择“更多信息”→“仍要运行”。

连接其他服务：
  .\kcoder-studio-remote.exe --server-url=http://服务器地址:端口 --token=访问令牌

说明：
- 这是远程薄客户端，不会在 Windows 本地启动 kcoder 或修改远端服务器配置。
- 默认开发令牌被编入此验收包，不适合正式发布。
- 当前包需要 Windows 10/11 x64。
