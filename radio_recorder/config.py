"""
설정 관리 모듈
config.yaml을 로드하고, 런타임 설정 변경을 관리합니다.
"""

import os
import secrets
import yaml
import logging

logger = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    "server": {
        "host": "0.0.0.0",
        "port": 8080,
        "secret_key": "change-me",
    },
    "recording": {
        "output_dir": os.path.expanduser("~/RadioRecordings"),
        "format": "mp3",
        "bitrate": "192k",
        "sample_rate": 44100,
        "max_retries": 3,
    },
    "auth": {
        "google_client_id": "",
        "google_client_secret": "",
        "allowed_emails": [],
        "rss_token": "",
    },
    "ad_detection": {
        "enabled": False,
        "silence_threshold_db": -40,
        "silence_min_duration": 0.5,
        "loudness_jump_threshold": 6,
    },
    "storage": {
        "nas": {
            "server": "",
            "share": "",
            "username": "",
            "password": "",
            "remote_dir": "/",
        }
    },
    "stations": {},
    "schedules": [],
}


class Config:
    """애플리케이션 설정 매니저"""

    def __init__(self, config_path: str = "config.yaml"):
        self.config_path = config_path
        self._data = {}
        self.load()

    def load(self):
        """config.yaml 파일을 로드합니다."""
        # 1. 먼저 기본값(DEFAULT_CONFIG) 설정
        self._data = DEFAULT_CONFIG.copy()

        # 2. 만약 /app/init-config/config.yaml이 존재하면 먼저 병합 (ConfigMap의 최신 방송국 정보 등 반영)
        init_config_path = "/app/init-config/config.yaml"
        if os.path.exists(init_config_path):
            try:
                with open(init_config_path, "r", encoding="utf-8") as f:
                    init_data = yaml.safe_load(f) or {}
                self._data = self._deep_merge(self._data, init_data)
                logger.info(f"초기 템플릿 설정을 병합했습니다: {init_config_path}")
            except Exception as e:
                logger.error(f"초기 템플릿 설정 병합 실패: {e}")

        # 3. 그 다음 활성 설정 파일(self.config_path)이 존재하면 병합 (사용자 저장 설정: 스케줄, 토큰 등)
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    file_data = yaml.safe_load(f) or {}
                self._data = self._deep_merge(self._data, file_data)
            except Exception as e:
                logger.error(f"활성 설정 파일 로드 실패: {e}")
        else:
            logger.warning(f"설정 파일을 찾을 수 없습니다: {self.config_path}")

        # RSS 토큰 자동 생성
        if not self._data["auth"].get("rss_token"):
            self._data["auth"]["rss_token"] = secrets.token_urlsafe(32)
            self.save()
            logger.info("RSS 피드 토큰이 자동 생성되었습니다.")

        # 녹음 디렉토리 생성
        output_dir = self.recording_dir
        os.makedirs(output_dir, exist_ok=True)

        # 데이터 디렉토리 생성
        os.makedirs("data", exist_ok=True)

    def save(self):
        """현재 설정을 config.yaml에 저장합니다."""
        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.dump(
                self._data,
                f,
                default_flow_style=False,
                allow_unicode=True,
                sort_keys=False,
            )

    def _deep_merge(self, base: dict, override: dict) -> dict:
        """두 딕셔너리를 깊은 병합합니다."""
        result = base.copy()
        for key, value in override.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key] = self._deep_merge(result[key], value)
            else:
                result[key] = value
        return result

    # === 편의 접근자 ===

    @property
    def server_host(self) -> str:
        return self._data["server"]["host"]

    @property
    def server_port(self) -> int:
        return self._data["server"]["port"]

    @property
    def secret_key(self) -> str:
        return self._data["server"]["secret_key"]

    @property
    def recording_dir(self) -> str:
        path = self._data["recording"]["output_dir"]
        return os.path.expanduser(path)

    @property
    def recording_format(self) -> str:
        return self._data["recording"]["format"]

    @property
    def recording_bitrate(self) -> str:
        return self._data["recording"]["bitrate"]

    @property
    def recording_sample_rate(self) -> int:
        return self._data["recording"]["sample_rate"]

    @property
    def max_retries(self) -> int:
        return self._data["recording"]["max_retries"]

    @property
    def google_client_id(self) -> str:
        return os.environ.get("GOOGLE_CLIENT_ID") or self._data["auth"].get("google_client_id", "")

    @property
    def google_client_secret(self) -> str:
        return os.environ.get("GOOGLE_CLIENT_SECRET") or self._data["auth"].get("google_client_secret", "")

    @property
    def allowed_emails(self) -> list:
        return self._data["auth"]["allowed_emails"]

    @property
    def rss_token(self) -> str:
        return self._data["auth"]["rss_token"]

    @property
    def ad_detection_enabled(self) -> bool:
        return self._data["ad_detection"]["enabled"]

    def set_ad_detection_enabled(self, value: bool):
        """광고 감지 활성화/비활성화 설정 및 저장"""
        self._data["ad_detection"]["enabled"] = value
        self.save()

    @property
    def ad_detection_config(self) -> dict:
        return self._data["ad_detection"]

    @property
    def nas_config(self) -> dict:
        return self._data.get("storage", {}).get("nas", {})

    def set_nas_config(self, nas_data: dict):
        """NAS 설정을 저장합니다."""
        if "storage" not in self._data:
            self._data["storage"] = {}
        self._data["storage"]["nas"] = nas_data
        self.save()

    @property
    def drive_config(self) -> dict:
        return self._data.get("storage", {}).get("drive", {"folder": "Radio Recordings"})

    def set_drive_config(self, drive_data: dict):
        """Drive 설정을 저장합니다."""
        if "storage" not in self._data:
            self._data["storage"] = {}
        self._data["storage"]["drive"] = drive_data
        self.save()

    @property
    def stations(self) -> dict:
        return self._data.get("stations", {})

    @property
    def schedules(self) -> list:
        return self._data.get("schedules", [])

    @schedules.setter
    def schedules(self, value: list):
        self._data["schedules"] = value

    def get_station(self, station_id: str) -> dict | None:
        """방송국 ID로 설정을 조회합니다."""
        station = self.stations.get(station_id)
        if station:
            return {**station, "id": station_id}
        return None

    def get_stations_by_network(self, network: str) -> dict:
        """네트워크(KBS/MBC/SBS)별 방송국 목록을 반환합니다."""
        return {
            sid: {**s, "id": sid}
            for sid, s in self.stations.items()
            if s.get("network", "").upper() == network.upper()
        }

    def to_dict(self) -> dict:
        """전체 설정을 딕셔너리로 반환합니다 (민감 정보 제외)."""
        safe = self._data.copy()
        if "auth" in safe:
            safe["auth"] = {
                "allowed_emails": safe["auth"].get("allowed_emails", []),
                "has_google_oauth": bool(self.google_client_id),
                "rss_token": safe["auth"].get("rss_token", ""),
            }
        return safe
