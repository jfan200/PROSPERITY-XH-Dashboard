#!/bin/bash
# ============================================================
# Docker Build & Push Script for PROSPERITY XH Dashboard
# Supports: linux/amd64 (required for cloud deployment)
# ============================================================

set -e

# Configuration
DOCKER_USERNAME="${DOCKER_USERNAME:-your-dockerhub-username}"
IMAGE_NAME="prosperity-xh-dashboard"
VERSION="${VERSION:-latest}"
PLATFORM="linux/amd64"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}PROSPERITY XH Dashboard - Docker Build & Push${NC}"
echo -e "${GREEN}============================================================${NC}"

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}Error: Docker is not running. Please start Docker and try again.${NC}"
  exit 1
fi

# Check if buildx is available
if ! docker buildx version > /dev/null 2>&1; then
  echo -e "${RED}Error: Docker buildx is not available. Please install Docker Desktop or enable buildx.${NC}"
  exit 1
fi

# Create buildx builder if not exists
echo -e "${YELLOW}Setting up buildx builder...${NC}"
docker buildx create --name multiarch --use 2>/dev/null || docker buildx use multiarch 2>/dev/null || true

# Login to Docker Hub
if [ -z "$DOCKER_PASSWORD" ]; then
  echo -e "${YELLOW}Please login to Docker Hub:${NC}"
  docker login
else
  echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin
fi

# Full image name
FULL_IMAGE_NAME="${DOCKER_USERNAME}/${IMAGE_NAME}"

echo -e "${GREEN}Building image: ${FULL_IMAGE_NAME}:${VERSION}${NC}"
echo -e "${GREEN}Platform: ${PLATFORM}${NC}"

# Build and push for linux/amd64
echo -e "${YELLOW}Building Docker image for ${PLATFORM}...${NC}"
docker buildx build \
  --platform ${PLATFORM} \
  --file Dockerfile \
  --tag "${FULL_IMAGE_NAME}:${VERSION}" \
  --tag "${FULL_IMAGE_NAME}:latest" \
  --push \
  .

echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}✅ Build and push completed successfully!${NC}"
echo -e "${GREEN}============================================================${NC}"
echo -e "${GREEN}Image: ${FULL_IMAGE_NAME}:${VERSION}${NC}"
echo -e "${GREEN}Platform: ${PLATFORM}${NC}"
echo ""
echo -e "${YELLOW}To pull and run:${NC}"
echo -e "  docker pull ${FULL_IMAGE_NAME}:${VERSION}"
echo -e "  docker run -d -p 3001:3001 --name dashboard ${FULL_IMAGE_NAME}:${VERSION}"
echo ""
echo -e "${YELLOW}To use in docker-compose.yml:${NC}"
echo -e "  image: ${FULL_IMAGE_NAME}:${VERSION}"
