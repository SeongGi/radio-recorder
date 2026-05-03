"""
FFmpeg 기반 녹음 엔진
HLS 스트림을 MP3 파일로 녹음합니다.
"""

import os
import subprocess
import threading
import time
import logging
from datetime import datetime
from enum import Enum

logger = logging.getLogger(__name__)


class RecordingStatus(Enum):
    PENDING = "pending"
    RECORDING = "recording"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RecordingJob:
    """단일 녹음 작업을 나타냅니다."""

    def __init__(
        self,
        job_id: str,
        station_id: str,
        station_name: str,
        output_path: str,
        duration_seconds: int,
        stream_url: str = "",
        referer: str = "",
    ):
        self.job_id = job_id
        self.station_id = station_id
        self.station_name = station_name
        self.output_path = output_path
        self.duration_seconds = duration_seconds
        self.stream_url = stream_url
        self.referer = referer

        self.status = RecordingStatus.PENDING
        self.start_time: datetime | None = None
        self.end_time: datetime | None = None
        self.file_size: int = 0
        self.error: str | None = None
        self._process: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None

    def to_dict(self) -> dict:
        """JSON 직렬화 가능한 딕셔너리를 반환합니다."""
        elapsed = 0
        if self.start_time:
            end = self.end_time or datetime.now()
            elapsed = int((end - self.start_time).total_seconds())

        return {
            "job_id": self.job_id,
            "station_id": self.station_id,
            "station_name": self.station_name,
            "output_path": self.output_path,
            "filename": os.path.basename(self.output_path),
            "duration_seconds": self.duration_seconds,
            "status": self.status.value,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "elapsed_seconds": elapsed,
            "progress_percent": min(100, int(elapsed / max(1, self.duration_seconds) * 100)),
            "file_size": self.file_size,
            "file_size_mb": round(self.file_size / 1024 / 1024, 1) if self.file_size else 0,
            "error": self.error,
        }


class Recorder:
    """FFmpeg를 제어하여 스트림을 녹음하는 엔진"""

    def __init__(self, config, file_tracker=None):
        self.config = config
        self.file_tracker = file_tracker
        self._active_jobs: dict[str, RecordingJob] = {}
        self._completed_jobs: list[dict] = []
        self._ad_detector = None

        # 광고 감지 모듈 초기화
        if config.ad_detection_enabled:
            from radio_recorder.ad_detector import AdDetector
            self._ad_detector = AdDetector(config.ad_detection_config)
            logger.info("광고 감지 기능 활성화")

        self._load_history()

    def _load_history(self):
        """녹음 기록을 로드합니다."""
        import json

        history_path = os.path.join("data", "recordings.json")
        if os.path.exists(history_path):
            try:
                with open(history_path, "r", encoding="utf-8") as f:
                    self._completed_jobs = json.load(f)
            except Exception:
                self._completed_jobs = []

    def _save_history(self):
        """녹음 기록을 저장합니다."""
        import json

        history_path = os.path.join("data", "recordings.json")
        # 최근 500건만 유지
        trimmed = self._completed_jobs[-500:]
        with open(history_path, "w", encoding="utf-8") as f:
            json.dump(trimmed, f, ensure_ascii=False, indent=2)

    def generate_output_path(self, station_name: str, schedule_label: str = "", start_time: datetime = None) -> str:
        """녹음 파일 경로를 생성합니다."""
        if start_time is None:
            start_time = datetime.now()

        # 라벨이 있으면 라벨 우선, 없으면 방송국 이름
        base_name = schedule_label if schedule_label else station_name
        
        # 파일명에 사용할 수 없는 특수문자 치환
        import re
        safe_name = re.sub(r'[\\/*?:"<>|]', '_', base_name).replace(" ", "_")
        filename = f"{safe_name}_{start_time.strftime('%Y%m%d_%H%M%S')}.{self.config.recording_format}"

        # 날짜별 폴더
        date_dir = start_time.strftime("%Y-%m-%d")
        output_dir = os.path.join(self.config.recording_dir, date_dir)
        os.makedirs(output_dir, exist_ok=True)

        return os.path.join(output_dir, filename)

    def start_recording(
        self,
        job_id: str,
        station_id: str,
        station_name: str,
        stream_url: str,
        referer: str,
        duration_seconds: int,
        schedule_label: str = "",
        retention_days: int = 0,
        storage_type: str = "LOCAL",
    ) -> RecordingJob:
        """녹음을 시작합니다."""

        output_path = self.generate_output_path(station_name, schedule_label)

        job = RecordingJob(
            job_id=job_id,
            station_id=station_id,
            station_name=station_name,
            output_path=output_path,
            duration_seconds=duration_seconds,
            stream_url=stream_url,
            referer=referer,
        )
        job.retention_days = retention_days
        job.storage_type = storage_type

        self._active_jobs[job_id] = job

        # 별도 스레드에서 녹음 실행
        job._thread = threading.Thread(
            target=self._record_thread,
            args=(job,),
            daemon=True,
        )
        job._thread.start()

        logger.info(
            f"녹음 시작: {station_name} ({duration_seconds}초) → {output_path}"
        )

        return job

    def _record_thread(self, job: RecordingJob):
        """녹음 스레드 (FFmpeg 서브프로세스 실행)"""
        try:
            job.status = RecordingStatus.RECORDING
            job.start_time = datetime.now()

            # FFmpeg 명령어 구성
            cmd = ["ffmpeg", "-y"]

            # Referer 헤더
            if job.referer:
                cmd.extend(["-headers", f"Referer: {job.referer}\r\n"])

            # 입력
            cmd.extend([
                "-i", job.stream_url,
                "-t", str(job.duration_seconds),
            ])

            # 출력 설정
            if self.config.recording_format == "mp3":
                cmd.extend([
                    "-acodec", "libmp3lame",
                    "-ab", self.config.recording_bitrate,
                    "-ar", str(self.config.recording_sample_rate),
                ])
            else:
                # AAC (원본 스트림 복사)
                cmd.extend(["-c", "copy", "-bsf:a", "aac_adtstoasc"])

            # 메타데이터
            cmd.extend([
                "-metadata", f"title={job.station_name}",
                "-metadata", f"artist={job.station_name}",
                "-metadata", f"date={job.start_time.strftime('%Y-%m-%d')}",
                "-metadata", f"comment=Recorded by RadioRecorder",
            ])

            cmd.append(job.output_path)

            logger.debug(f"FFmpeg 명령어: {' '.join(cmd)}")

            # FFmpeg 실행
            job._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            # 녹음 중 파일 크기 모니터링
            monitor_thread = threading.Thread(
                target=self._monitor_file_size,
                args=(job,),
                daemon=True,
            )
            monitor_thread.start()

            # 완료 대기
            _, stderr = job._process.communicate()

            if job.status == RecordingStatus.CANCELLED:
                return

            if job._process.returncode == 0:
                job.status = RecordingStatus.COMPLETED
                job.end_time = datetime.now()
                if os.path.exists(job.output_path):
                    job.file_size = os.path.getsize(job.output_path)
                logger.info(
                    f"녹음 완료: {job.station_name} "
                    f"({job.file_size / 1024 / 1024:.1f}MB)"
                )

                # 원본 파일 Tracker 등록
                if self.file_tracker and os.path.exists(job.output_path):
                    rel_path = os.path.relpath(job.output_path, self.config.recording_dir)
                    size_bytes = os.path.getsize(job.output_path)
                    self.file_tracker.add_local_file(
                        filename=rel_path,
                        size_bytes=size_bytes,
                        retention_days=getattr(job, 'retention_days', 0)
                    )

                # 광고 제거 (활성화된 경우)
                if self._ad_detector and os.path.exists(job.output_path):
                    try:
                        logger.info(f"광고 감지 시작: {job.station_name}")
                        clean_path = self._ad_detector.remove_ads(job.output_path)
                        if clean_path:
                            clean_size = os.path.getsize(clean_path)
                            logger.info(
                                f"광고 제거 완료: {os.path.basename(clean_path)} "
                                f"({clean_size / 1024 / 1024:.1f}MB)"
                            )
                            # 클린 버전 Tracker 등록
                            if self.file_tracker and os.path.exists(clean_path):
                                clean_rel_path = os.path.relpath(clean_path, self.config.recording_dir)
                                self.file_tracker.add_local_file(
                                    filename=clean_rel_path,
                                    size_bytes=os.path.getsize(clean_path),
                                    retention_days=getattr(job, 'retention_days', 0)
                                )
                        else:
                            logger.info(f"광고 미감지 (원본 유지): {job.station_name}")
                    except Exception as e:
                        logger.warning(f"광고 제거 실패 (원본 유지): {e}")

                # 자동 저장 위치 처리 (NAS/DRIVE)
                storage_type = getattr(job, 'storage_type', 'LOCAL')
                if storage_type != 'LOCAL' and hasattr(self, 'storage_manager'):
                    logger.info(f"자동 저장 처리 시작: {storage_type}")
                    rel_path = os.path.relpath(job.output_path, self.config.recording_dir)
                    
                    if storage_type == 'NAS':
                        self.storage_manager.move_to_nas(rel_path)
                    elif storage_type == 'DRIVE':
                        refresh_token = None
                        if hasattr(self, 'get_refresh_token_func'):
                            refresh_token = self.get_refresh_token_func()
                        if refresh_token:
                            self.storage_manager.upload_to_drive(rel_path, refresh_token)
                        else:
                            logger.warning("Google Drive 리프레시 토큰이 없어 자동 업로드를 건너뜁니다.")
            else:
                job.status = RecordingStatus.FAILED
                job.end_time = datetime.now()
                job.error = stderr.decode("utf-8", errors="replace")[-500:]
                logger.error(f"녹음 실패: {job.station_name} - {job.error}")

        except Exception as e:
            job.status = RecordingStatus.FAILED
            job.end_time = datetime.now()
            job.error = str(e)
            logger.exception(f"녹음 중 예외 발생: {job.station_name}")

        finally:
            # 완료된 작업을 기록에 추가
            job_dict = job.to_dict()
            self._completed_jobs.append(job_dict)
            self._save_history()

            # 활성 목록에서 제거 (지연)
            time.sleep(30)  # 30초 후 제거 (UI에서 완료 상태 확인 가능)
            self._active_jobs.pop(job.job_id, None)

    def _monitor_file_size(self, job: RecordingJob):
        """녹음 중 파일 크기를 주기적으로 업데이트합니다."""
        while job.status == RecordingStatus.RECORDING:
            try:
                if os.path.exists(job.output_path):
                    job.file_size = os.path.getsize(job.output_path)
            except OSError:
                pass
            time.sleep(5)

    def cancel_recording(self, job_id: str) -> bool:
        """녹음을 중지합니다."""
        job = self._active_jobs.get(job_id)
        if not job:
            return False

        job.status = RecordingStatus.CANCELLED
        job.end_time = datetime.now()

        if job._process and job._process.poll() is None:
            job._process.terminate()
            try:
                job._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                job._process.kill()

        logger.info(f"녹음 중지: {job.station_name}")
        return True

    def get_active_jobs(self) -> list[dict]:
        """진행 중인 녹음 목록을 반환합니다."""
        return [job.to_dict() for job in self._active_jobs.values()]

    def get_history(self, limit: int = 50) -> list[dict]:
        """녹음 기록을 반환합니다."""
        return list(reversed(self._completed_jobs[-limit:]))

    def get_recording_files(self) -> list[dict]:
        """녹음된 파일 목록을 반환합니다."""
        files = []
        recording_dir = self.config.recording_dir

        if not os.path.exists(recording_dir):
            return files

        for root, _, filenames in os.walk(recording_dir):
            for filename in sorted(filenames, reverse=True):
                if filename.endswith((".mp3", ".aac", ".m4a")):
                    filepath = os.path.join(root, filename)
                    stat = os.stat(filepath)
                    files.append({
                        "filename": filename,
                        "path": filepath,
                        "relative_path": os.path.relpath(filepath, recording_dir),
                        "size": stat.st_size,
                        "size_mb": round(stat.st_size / 1024 / 1024, 1),
                        "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    })

        return files
