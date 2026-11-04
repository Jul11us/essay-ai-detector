# syntax=docker/dockerfile:1
#
# 单容器：FastAPI 后端 + 构建好的前端。权重不在镜像里（体积大，许可证也各自不同），
# 放在挂载的 /models 卷上，见 docs/docker.md。
#
# 基础镜像和包源都能用 build-arg 换，例如：
#   docker build --build-arg PYTHON_IMAGE=mirror.gcr.io/library/python:3.11-slim \
#                --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-slim -t essay-ai-detector .
ARG PYTHON_IMAGE=python:3.11-slim
ARG NODE_IMAGE=node:22-slim

# ---- 前端构建 ----
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
ARG NPM_REGISTRY=
COPY frontend/package.json frontend/package-lock.json ./
# 锁文件里记着每个包的下载地址（npmjs 和 npmmirror 都有）。给了 NPM_REGISTRY 就把它们
# 统一换成这个源，否则按锁文件里的地址下载。
RUN if [ -n "$NPM_REGISTRY" ]; then \
      npm config set registry "$NPM_REGISTRY" && npm config set replace-registry-host always; \
    fi \
 && npm ci
COPY frontend/ ./
RUN npm run build

# ---- 运行 ----
FROM ${PYTHON_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf \
    VANGUARD_MODEL_PATH=/models/vanguard \
    DETECTOR_STATIC_DIR=/app/frontend-dist

WORKDIR /app/backend

# 先装 CPU 版 torch：默认 PyPI 的是带 CUDA 的大包，镜像会大好几倍。
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG PIP_INDEX_URL=
RUN pip install torch --index-url "$TORCH_INDEX"
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt ${PIP_INDEX_URL:+--index-url "$PIP_INDEX_URL"}

COPY backend/app ./app
COPY experiments/download_model.py /app/experiments/download_model.py
COPY --from=frontend /build/dist /app/frontend-dist

# 非 root 运行；/models 预先建好并交给它，这样空的命名卷挂上来时权限是对的。
RUN useradd --create-home --uid 1000 app \
 && mkdir -p /models \
 && chown -R app:app /models
USER app
VOLUME /models

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

# 容器里要监听 0.0.0.0 才能被映射出去；只对本机开放由 compose 的端口映射（127.0.0.1）保证。
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
