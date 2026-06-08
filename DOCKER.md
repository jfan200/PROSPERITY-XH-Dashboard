# Docker 镜像构建与上传指南

## 前提条件

1. 安装 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
2. 拥有 [Docker Hub](https://hub.docker.com/) 账号
3. 确保 Docker 正在运行

## 快速开始

### 1. 登录 Docker Hub

```bash
docker login
```

### 2. 设置环境变量

```bash
export DOCKER_USERNAME=your-dockerhub-username
export VERSION=1.0.0  # 可选，默认为 latest
```

### 3. 构建并上传镜像

```bash
# 使用构建脚本
./docker-build-push.sh

# 或者手动构建
docker buildx create --name multiarch --use
docker buildx build \
  --platform linux/amd64 \
  --tag $DOCKER_USERNAME/prosperity-xh-dashboard:latest \
  --push .
```

## 使用预构建镜像

### 方式一：使用 docker-compose.hub.yml

```bash
# 设置环境变量
export DOCKER_USERNAME=your-dockerhub-username

# 启动服务
docker compose -f docker-compose.hub.yml up -d
```

### 方式二：直接运行

```bash
docker pull $DOCKER_USERNAME/prosperity-xh-dashboard:latest
docker run -d \
  -p 3001:3001 \
  -v dashboard-data:/app/data \
  --name dashboard \
  $DOCKER_USERNAME/prosperity-xh-dashboard:latest
```

## 多平台构建

如果需要同时支持 ARM64 和 AMD64：

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag $DOCKER_USERNAME/prosperity-xh-dashboard:latest \
  --push .
```

## 环境变量

在 `.env.docker` 文件中配置：

```bash
TAPTOUCH_EMAIL=your-email@example.com
TAPTOUCH_PASSWORD=your-password
PORT=3001
```

## 常见问题

### Q: 构建失败，提示 "image does not support the target platform architecture"

A: 确保使用 `--platform linux/amd64` 参数构建：

```bash
docker buildx build --platform linux/amd64 ...
```

### Q: 如何查看镜像支持的平台？

A: 使用以下命令：

```bash
docker manifest inspect $DOCKER_USERNAME/prosperity-xh-dashboard:latest
```

### Q: 构建很慢怎么办？

A: 首次构建需要下载 Chromium，后续构建会使用缓存。可以使用 `--cache-from` 参数加速。

## 部署到云服务

### 部署到 Railway

1. 连接 GitHub 仓库
2. 设置环境变量
3. Railway 会自动构建并部署

### 部署到 Fly.io

```bash
fly launch
fly deploy
```

### 部署到 Google Cloud Run

```bash
gcloud run deploy prosperity-xh-dashboard \
  --image $DOCKER_USERNAME/prosperity-xh-dashboard:latest \
  --port 3001 \
  --platform managed
```

## 相关文件

- `Dockerfile` - Docker 镜像定义
- `docker-compose.yml` - 本地构建配置
- `docker-compose.hub.yml` - 使用 Docker Hub 镜像配置
- `docker-build-push.sh` - 构建并上传脚本
- `.env.docker.example` - 环境变量模板
