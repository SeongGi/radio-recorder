FROM python:3.12-slim

LABEL maintainer="radio-recorder"
LABEL description="한국 라디오 예약 녹음 프로그램"

# ffmpeg 설치
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# 작업 디렉토리
WORKDIR /app

# Python 의존성 설치 (캐시 활용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 애플리케이션 코드 복사
COPY . .

# 데이터 디렉토리 생성
RUN mkdir -p /app/data /app/recordings

# 포트 노출
EXPOSE 8080

# 환경 변수
ENV PYTHONUNBUFFERED=1

# 헬스체크
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8080/auth/status', timeout=3)" || exit 1

# 실행
CMD ["python", "run.py"]
