# 📻 Radio Recorder

한국 라디오 예약 녹음 프로그램.  
예약된 시간에 자동으로 라디오를 녹음하여 MP3 파일로 저장하고, 팟캐스트 앱이나 웹 대시보드에서 청취할 수 있습니다.

---

## ✨ 주요 기능

| 기능 | 설명 |
|------|------|
| **예약 녹음** | 요일/시간 지정 반복 녹음, 단발성 녹음 |
| **17개 채널** | KBS, MBC, SBS, EBS, CBS, TBS, BBS, OBS, YTN |
| **라이브 청취** | 대시보드에서 실시간 스트리밍 청취 (HLS) |
| **웹 대시보드** | 다크모드 프리미엄 UI — 예약/녹음/파일 관리 |
| **Google OAuth** | 외부 접근 시 Google 계정 인증으로 보호 (선택) |
| **Podcast RSS** | 팟캐스트 앱(Apple Podcasts, Pocket Casts 등)으로 구독 |
| **외부 저장소** | 녹음 완료 후 NAS(SMB) 또는 Google Drive 자동 이동 |
| **PWA 지원** | 모바일 홈 화면에 앱으로 추가, 뒤로가기 시 앱 종료 |
| **광고 감지** | 무음/음량 분석 기반 광고 제거 (실험적, 원본 보존) |
| **컨테이너** | Docker + k3d/Kubernetes 배포 지원 |

---

## 📻 지원 방송국

| 방송사 | 채널 |
|--------|------|
| **KBS** | 1라디오, 2라디오(해피FM), 클래식FM, 쿨FM, 한민족방송 |
| **MBC** | 표준FM, FM4U, 올댓뮤직 |
| **SBS** | 파워FM, 러브FM |
| **EBS** | EBS FM |
| **CBS** | 표준FM, 음악FM |
| **TBS** | 교통방송, eFM(영어) |
| **BBS** | 불교방송 |
| **OBS** | 경인방송 |
| **YTN** | YTN 라디오 |

> `config.yaml`의 `stations` 섹션에 항목을 추가하면 언제든지 방송국을 늘릴 수 있습니다.

---

## 🏗️ 아키텍처

```
외부 (HTTPS)
  │
  ├── 웹 브라우저 → Google OAuth → 대시보드 (예약/녹음/파일)
  ├── 핸드폰 브라우저 → PWA 앱처럼 사용
  └── 팟캐스트 앱 → RSS 피드 (토큰 인증)
        │
  ┌─────▼──────────────────────────────────────┐
  │  Mac Mini (k3d Cluster)                     │
  │                                             │
  │  Flask Server ←→ APScheduler               │
  │       ↓              ↓                      │
  │  Stream Resolver → FFmpeg Recorder          │
  │  (bsod.kr → API → radio-browser.info)       │
  │       ↓                                     │
  │  PersistentVolume (녹음 파일)               │
  │       ↓                                     │
  │  StorageManager → NAS / Google Drive        │
  └─────────────────────────────────────────────┘
```

---

## 🚀 빠른 시작

### 사전 요구사항

- **Python 3.11+**
- **FFmpeg** (`brew install ffmpeg` 또는 `apt install ffmpeg`)
- **Docker** (k3d 배포 시)

### 1. 클론 및 설치

```bash
git clone https://github.com/SeongGi/radio-recorder.git
cd radio-recorder
pip install -r requirements.txt
```

### 2. 설정

`config.yaml`을 열어 최소한 아래 항목을 수정합니다:

```yaml
auth:
  google_client_id: "YOUR_GOOGLE_CLIENT_ID"
  google_client_secret: "YOUR_GOOGLE_CLIENT_SECRET"
  allowed_emails:
    - "your.email@gmail.com"
```

> **Google OAuth 설정 방법**:
> 1. [GCP Console](https://console.cloud.google.com/apis/credentials) 접속
> 2. OAuth 2.0 Client ID 생성 (웹 애플리케이션)
> 3. Authorized redirect URI: `https://your-domain.com/auth/callback`
> 4. Client ID와 Secret을 config.yaml에 입력

> 💡 **개발/테스트 시**: OAuth를 설정하지 않으면 인증 바이패스 모드로 동작합니다.

### 3. 실행

```bash
# 서버 시작
python run.py

# 스트림 연결 테스트
python run.py --test-streams

# 특정 방송국 10초 테스트 녹음
python run.py --test-record kbs_classic -d 10
```

---

## 🐳 Docker / k3d 배포

### Docker 단독 실행

```bash
# 이미지 빌드
docker build -t radio-recorder .

# 실행
docker run -d \
  --name radio-recorder \
  -p 8080:8080 \
  -v ~/RadioRecordings:/app/recordings \
  -v ~/radio-data:/app/data \
  radio-recorder
```

### k3d (Kubernetes) 배포

```bash
# 1. k3d 클러스터 생성 (최초 1회)
k3d cluster create radio --port "8080:80@loadbalancer"

# 2. 이미지 빌드 & k3d에 로드
docker build -t radio-recorder:latest .
k3d image import radio-recorder:latest -c radio

# 3. Secret 설정 (Google OAuth)
kubectl create secret generic radio-recorder-oauth \
  --from-literal=GOOGLE_CLIENT_ID="your-client-id" \
  --from-literal=GOOGLE_CLIENT_SECRET="your-client-secret"

# 4. 배포
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml

# 5. 상태 확인
kubectl get pods -w
```

---

## 📱 핸드폰에서 듣기

### 방법 1: PWA 앱으로 설치
1. 브라우저에서 `https://your-domain.com` 접속
2. Google 로그인
3. 브라우저 메뉴 → **"홈 화면에 추가"** 선택
4. 설치된 앱처럼 사용 (뒤로가기 버튼으로 앱 종료)

### 방법 2: 팟캐스트 앱 구독
1. 대시보드 → ⚙️ 설정 → RSS 피드 URL 복사
2. 팟캐스트 앱에서 "URL로 추가" → 붙여넣기
3. 새 녹음이 자동으로 피드에 추가됨

---

## 📂 프로젝트 구조

```
radio/
├── run.py                    # 엔트리포인트 (CLI + 서버)
├── config.yaml               # 설정 (방송국, 인증, 녹음 옵션)
├── requirements.txt          # Python 의존성
├── Dockerfile                # 컨테이너 이미지
│
├── radio_recorder/           # 핵심 모듈
│   ├── config.py             # 설정 관리
│   ├── stream_resolver.py    # 스트림 URL 해석 (3단계 폴백)
│   ├── recorder.py           # FFmpeg 녹음 엔진
│   ├── scheduler.py          # APScheduler 예약
│   ├── storage.py            # NAS / Google Drive 업로드
│   ├── file_tracker.py       # 녹음 파일 메타데이터 추적
│   ├── ad_detector.py        # 광고 감지 (실험적)
│   └── podcast_feed.py       # RSS 피드 생성
│
├── web/                      # 웹 서버
│   ├── app.py                # Flask + REST API
│   ├── auth.py               # Google OAuth 2.0
│   ├── templates/
│   │   ├── login.html        # 로그인 페이지
│   │   ├── dashboard.html    # 대시보드
│   │   └── player.html       # 파일 플레이어
│   └── static/
│       ├── style.css         # 다크모드 UI
│       ├── app.js            # 대시보드 JS
│       ├── sw.js             # 서비스 워커 (PWA 캐싱)
│       ├── manifest.json     # PWA 매니페스트
│       ├── icon-192.png      # PWA 아이콘
│       └── icon-512.png
│
└── k8s/                      # Kubernetes 매니페스트
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    ├── pvc.yaml
    ├── configmap.yaml
    └── secret.yaml
```

---

## ⚙️ 설정 상세

### 방송국 추가

`config.yaml`의 `stations` 섹션에 추가:

```yaml
stations:
  my_station:
    name: "방송국 이름"
    network: "방송사"
    stream_source: "bsod"
    stream_params:
      stn: "방송사코드"
      ch: "채널코드"
```

### 예약 녹음 (CLI에서 직접 설정)

`config.yaml`의 `schedules` 섹션:

```yaml
schedules:
  - id: "morning_classic"
    station_id: "kbs_classic"
    days: ["mon", "tue", "wed", "thu", "fri"]
    start_time: "07:00"
    duration_minutes: 120
    retention_days: 7       # 7일 후 자동 삭제 (0 = 영구 보관)
    storage_type: "LOCAL"   # LOCAL / NAS / DRIVE
    enabled: true
```

### 외부 저장소 설정

```yaml
storage:
  nas:
    server: "192.168.1.100"   # NAS IP
    share: "radio"            # 공유 폴더명
    username: "user"
    password: "password"
    remote_dir: "/recordings"
  drive:
    folder: "Radio Recordings"  # Google Drive 내 저장 폴더명
```

---

## 🔧 CLI 옵션

```
python run.py [옵션]

옵션:
  --test-streams              모든 방송국 스트림 연결 테스트
  --test-record STATION_ID    특정 방송국 테스트 녹음
  -d, --duration SECONDS      테스트 녹음 시간 (기본: 10초)
  -c, --config PATH           설정 파일 경로 (기본: config.yaml)
  --debug                     디버그 로깅
```

---

## ⚠️ 참고사항

- 이 프로그램은 **개인 청취 용도**로만 사용하세요.
- 녹음 파일의 재배포나 상업적 이용은 저작권법 위반입니다.
- 스트림 URL은 방송사 정책 변경에 따라 작동하지 않을 수 있습니다.
- 광고 감지는 실험적 기능이며 100% 정확하지 않습니다.

---

## 📄 License

MIT License — 개인 사용 목적으로 자유롭게 수정 및 사용 가능합니다.
