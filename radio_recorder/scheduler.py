"""
APScheduler 기반 예약 녹음 관리
Cron 트리거로 반복 예약, 단발성 예약을 지원합니다.
"""

import os
import json
import uuid
import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

logger = logging.getLogger(__name__)

DAY_MAP = {
    "mon": "0", "tue": "1", "wed": "2", "thu": "3",
    "fri": "4", "sat": "5", "sun": "6",
}

SCHEDULES_FILE = os.path.join("data", "schedules.json")


class RecordingScheduler:
    """예약 녹음 관리자"""

    def __init__(self, config, stream_resolver, recorder):
        self.config = config
        self.stream_resolver = stream_resolver
        self.recorder = recorder
        self._schedules: list[dict] = []
        self._scheduler = BackgroundScheduler(
            timezone="Asia/Seoul",
            job_defaults={"max_instances": 3},
        )

    def start(self):
        """스케줄러를 시작하고 저장된 예약을 복원합니다."""
        self._load_schedules()
        self._restore_jobs()
        self._scheduler.start()
        logger.info(f"스케줄러 시작 (등록된 예약: {len(self._schedules)}개)")

    def shutdown(self):
        """스케줄러를 종료합니다."""
        self._scheduler.shutdown(wait=False)
        logger.info("스케줄러 종료")

    # === 예약 CRUD ===

    def add_schedule(
        self,
        station_id: str,
        days: list[str],
        start_time: str,
        duration_minutes: int,
        label: str = "",
        enabled: bool = True,
    ) -> dict:
        """새 예약을 추가합니다."""
        schedule_id = str(uuid.uuid4())[:8]

        station = self.config.get_station(station_id)
        if not station:
            raise ValueError(f"알 수 없는 방송국: {station_id}")

        schedule = {
            "id": schedule_id,
            "station_id": station_id,
            "station_name": station.get("name", station_id),
            "days": days,
            "start_time": start_time,
            "duration_minutes": duration_minutes,
            "label": label or station.get("name", station_id),
            "enabled": enabled,
            "created_at": datetime.now().isoformat(),
        }

        self._schedules.append(schedule)
        self._save_schedules()

        if enabled:
            self._register_job(schedule)

        logger.info(
            f"예약 추가: {schedule['label']} "
            f"({', '.join(days)} {start_time}, {duration_minutes}분)"
        )

        return schedule

    def add_onetime_schedule(
        self,
        station_id: str,
        start_datetime: str,
        duration_minutes: int,
        label: str = "",
    ) -> dict:
        """단발성 예약을 추가합니다."""
        schedule_id = str(uuid.uuid4())[:8]

        station = self.config.get_station(station_id)
        if not station:
            raise ValueError(f"알 수 없는 방송국: {station_id}")

        schedule = {
            "id": schedule_id,
            "station_id": station_id,
            "station_name": station.get("name", station_id),
            "type": "onetime",
            "start_datetime": start_datetime,
            "duration_minutes": duration_minutes,
            "label": label or station.get("name", station_id),
            "enabled": True,
            "created_at": datetime.now().isoformat(),
        }

        self._schedules.append(schedule)
        self._save_schedules()

        # DateTrigger로 등록
        trigger_time = datetime.fromisoformat(start_datetime)
        self._scheduler.add_job(
            self._execute_recording,
            trigger=DateTrigger(run_date=trigger_time),
            args=[schedule],
            id=f"schedule_{schedule_id}",
            replace_existing=True,
        )

        logger.info(
            f"단발 예약 추가: {schedule['label']} ({start_datetime}, {duration_minutes}분)"
        )

        return schedule

    def update_schedule(self, schedule_id: str, updates: dict) -> dict | None:
        """예약을 수정합니다."""
        for i, s in enumerate(self._schedules):
            if s["id"] == schedule_id:
                # 기존 작업 제거
                self._unregister_job(schedule_id)

                # 업데이트 적용
                self._schedules[i].update(updates)
                self._save_schedules()

                # 활성화 상태면 재등록
                if self._schedules[i].get("enabled", True):
                    self._register_job(self._schedules[i])

                logger.info(f"예약 수정: {schedule_id}")
                return self._schedules[i]

        return None

    def delete_schedule(self, schedule_id: str) -> bool:
        """예약을 삭제합니다."""
        for i, s in enumerate(self._schedules):
            if s["id"] == schedule_id:
                self._unregister_job(schedule_id)
                self._schedules.pop(i)
                self._save_schedules()
                logger.info(f"예약 삭제: {schedule_id}")
                return True
        return False

    def toggle_schedule(self, schedule_id: str) -> dict | None:
        """예약 활성화/비활성화를 토글합니다."""
        for s in self._schedules:
            if s["id"] == schedule_id:
                s["enabled"] = not s.get("enabled", True)
                self._save_schedules()

                if s["enabled"]:
                    self._register_job(s)
                else:
                    self._unregister_job(schedule_id)

                logger.info(f"예약 {'활성화' if s['enabled'] else '비활성화'}: {schedule_id}")
                return s
        return None

    def get_schedules(self) -> list[dict]:
        """모든 예약 목록을 반환합니다."""
        return self._schedules.copy()

    def get_schedule(self, schedule_id: str) -> dict | None:
        """예약을 조회합니다."""
        for s in self._schedules:
            if s["id"] == schedule_id:
                return s
        return None

    # === 내부 메서드 ===

    def _register_job(self, schedule: dict):
        """APScheduler에 작업을 등록합니다."""
        schedule_id = schedule["id"]
        job_id = f"schedule_{schedule_id}"

        if schedule.get("type") == "onetime":
            trigger_time = datetime.fromisoformat(schedule["start_datetime"])
            if trigger_time > datetime.now():
                self._scheduler.add_job(
                    self._execute_recording,
                    trigger=DateTrigger(run_date=trigger_time),
                    args=[schedule],
                    id=job_id,
                    replace_existing=True,
                )
            return

        # Cron 트리거 (반복 예약)
        days = schedule.get("days", [])
        start_time = schedule.get("start_time", "00:00")

        hour, minute = start_time.split(":")

        # 요일 변환
        if days:
            day_of_week = ",".join(DAY_MAP.get(d.lower(), d) for d in days)
        else:
            day_of_week = "*"

        trigger = CronTrigger(
            day_of_week=day_of_week,
            hour=int(hour),
            minute=int(minute),
            timezone="Asia/Seoul",
        )

        self._scheduler.add_job(
            self._execute_recording,
            trigger=trigger,
            args=[schedule],
            id=job_id,
            replace_existing=True,
        )

    def _unregister_job(self, schedule_id: str):
        """APScheduler에서 작업을 제거합니다."""
        job_id = f"schedule_{schedule_id}"
        try:
            self._scheduler.remove_job(job_id)
        except Exception:
            pass

    def _execute_recording(self, schedule: dict):
        """예약된 녹음을 실행합니다."""
        station_id = schedule["station_id"]
        duration_minutes = schedule["duration_minutes"]

        logger.info(f"예약 녹음 실행: {schedule.get('label', station_id)}")

        station = self.config.get_station(station_id)
        if not station:
            logger.error(f"방송국을 찾을 수 없습니다: {station_id}")
            return

        # 스트림 URL 획득 (재시도 포함)
        stream_info = None
        for attempt in range(self.config.max_retries):
            try:
                stream_info = self.stream_resolver.resolve(station)
                break
            except Exception as e:
                logger.warning(
                    f"스트림 획득 실패 (시도 {attempt + 1}/{self.config.max_retries}): {e}"
                )
                if attempt < self.config.max_retries - 1:
                    import time
                    time.sleep(5)

        if not stream_info:
            logger.error(f"스트림 URL 획득 최종 실패: {station_id}")
            return

        # 녹음 시작
        job_id = f"rec_{schedule['id']}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"

        self.recorder.start_recording(
            job_id=job_id,
            station_id=station_id,
            station_name=station.get("name", station_id),
            stream_url=stream_info["url"],
            referer=stream_info.get("referer", ""),
            duration_seconds=duration_minutes * 60,
        )

    def _load_schedules(self):
        """저장된 예약을 로드합니다."""
        if os.path.exists(SCHEDULES_FILE):
            try:
                with open(SCHEDULES_FILE, "r", encoding="utf-8") as f:
                    self._schedules = json.load(f)
                logger.info(f"예약 {len(self._schedules)}개 로드됨")
            except Exception as e:
                logger.error(f"예약 로드 실패: {e}")
                self._schedules = []
        else:
            self._schedules = []

    def _save_schedules(self):
        """예약을 파일에 저장합니다."""
        os.makedirs("data", exist_ok=True)
        with open(SCHEDULES_FILE, "w", encoding="utf-8") as f:
            json.dump(self._schedules, f, ensure_ascii=False, indent=2)

    def _restore_jobs(self):
        """저장된 예약을 APScheduler에 복원합니다."""
        count = 0
        for schedule in self._schedules:
            if schedule.get("enabled", True):
                try:
                    self._register_job(schedule)
                    count += 1
                except Exception as e:
                    logger.warning(f"예약 복원 실패 [{schedule['id']}]: {e}")
        logger.info(f"예약 {count}개 복원됨")
