# 用 Docker 运行

一个容器里同时跑后端和已经构建好的前端，浏览器只需要打开 `http://127.0.0.1:8000`。适合不想在本机装 Python 和 Node 的人，也方便在 macOS / Linux 上使用。**镜像不含模型权重**（体积大，各自许可证也不同），权重放在 `models` 卷里。

## 第一次使用

```bash
docker compose build
docker compose --profile tools run --rm download-models   # 下载英文模型到 models 卷
docker compose up -d
```

然后打开 <http://127.0.0.1:8000>，等页面显示“英文可用”再检测。中文模型在容器第一次启动时自动下载到同一个卷（`HF_HOME=/models/hf`），之后不再重复下载。看进度：`docker compose logs -f detector`。

- 停止：`docker compose down`（权重保留在卷里）。
- 连权重一起删：`docker compose down -v`。
- 只支持 CPU。没有包含 ONNX 加速，也没有配置 GPU。
- 模型加载需要数 GB 内存。如果容器被杀（退出码 137），调大 Docker 的内存上限。

## 安全与隐私

`compose.yaml` 把端口只映射到 `127.0.0.1`。这个服务**没有登录也没有次数限制**，不要改成 `0.0.0.0:8000`，也不要直接放到公网。正文只在容器里处理，不会发给第三方评分接口；联网只发生在下载模型权重时。容器以非 root 用户运行。

## 构建选项

基础镜像和包源都可以用 `--build-arg` 替换：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `PYTHON_IMAGE` | `python:3.11-slim` | 访问不了 Docker Hub 时换成镜像站 |
| `NODE_IMAGE` | `node:22-slim` | 同上 |
| `TORCH_INDEX` | `https://download.pytorch.org/whl/cpu` | CPU 版 torch 的源；用默认 PyPI 会装带 CUDA 的大包，镜像大好几倍 |
| `PIP_INDEX_URL` | 空 | 其余 Python 依赖的源 |
| `NPM_REGISTRY` | 空 | 给了就把锁文件里所有包的下载地址换成这个源 |

例如：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`。

## 和本机开发的区别

- 开发时前端由 Vite 另起（5173 端口），后端只提供 `/api`。容器里后端通过环境变量 `DETECTOR_STATIC_DIR` 直接伺服构建好的前端，所以只有 8000 一个端口，也不需要 CORS。
- 改了代码要 `docker compose build` 重新构建；开发仍然建议用 `scripts/dev.sh` 或 Windows 的启动脚本。
- CI 会构建这个镜像并做一次冒烟检查（镜像能起、`/` 和 `/api/health` 都有响应、非 root），不加载模型。
