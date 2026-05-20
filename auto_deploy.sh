#!/bin/bash
# ==============================================================================
# GitHub Auto Deploy Script for Radio Recorder
# ==============================================================================
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/seonggi/Desktop/PDS/dev/radio-recorder"
cd "$PROJECT_DIR" || exit 1

# Git 원격 상태 갱신
git fetch origin main > /dev/null 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u})

# 로컬과 원격의 커밋이 다르면 빌드 및 배포 시작
if [ "$LOCAL" != "$REMOTE" ]; then
    echo "$(date): New update detected! Starting deployment..."
    
    # 최신 코드 pull
    git pull origin main
    
    # Docker 이미지 빌드
    docker build -t radio-recorder:latest .
    
    # k3d 이미지 임포트
    k3d image import radio-recorder:latest -c radio-recorder-cluster
    
    # k8s ConfigMap 및 Deployment 롤아웃 재시작
    kubectl config use-context k3d-radio-recorder-cluster
    kubectl apply -f k8s/configmap.yaml
    kubectl rollout restart deployment radio-recorder
    
    echo "$(date): Deployment completed successfully!"
fi
