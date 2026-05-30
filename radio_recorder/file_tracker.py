import os
import json
import uuid
import logging
import threading
from datetime import datetime

logger = logging.getLogger(__name__)

class FileTracker:
    def __init__(self, data_dir: str):
        self.db_path = os.path.join(data_dir, "files_meta.json")
        self.lock = threading.Lock()
        self._data = {}
        self.load()

    def load(self):
        """저장된 파일 메타데이터 로드"""
        with self.lock:
            if os.path.exists(self.db_path):
                try:
                    with open(self.db_path, "r", encoding="utf-8") as f:
                        self._data = json.load(f)
                except Exception as e:
                    logger.error(f"파일 메타데이터 로드 실패: {e}")
                    self._data = {}
            else:
                self._data = {}

    def save(self):
        """파일 메타데이터 저장"""
        with self.lock:
            try:
                with open(self.db_path, "w", encoding="utf-8") as f:
                    json.dump(self._data, f, ensure_ascii=False, indent=2)
            except Exception as e:
                logger.error(f"파일 메타데이터 저장 실패: {e}")

    def add_local_file(self, filename: str, size_bytes: int, created_iso: str = None, retention_days: int = 0) -> str:
        """새로운 로컬 파일 등록"""
        file_id = str(uuid.uuid4())
        
        # 이미 동일한 파일명이 있다면 기존 메타데이터 유지
        for fid, meta in self._data.items():
            if meta.get("filename") == filename and meta.get("status") == "LOCAL":
                meta["size_bytes"] = size_bytes
                if retention_days > 0:
                    meta["retention_days"] = retention_days
                self.save()
                return fid

        self._data[file_id] = {
            "id": file_id,
            "filename": filename,
            "status": "LOCAL",
            "size_bytes": size_bytes,
            "created": created_iso or datetime.now().isoformat(),
            "retention_days": retention_days,
            "drive_url": None
        }
        self.save()
        return file_id

    def update_status(self, file_id: str, status: str, drive_url: str = None):
        """파일 상태 업데이트 (NAS, DRIVE 등)"""
        if file_id in self._data:
            self._data[file_id]["status"] = status
            if drive_url:
                self._data[file_id]["drive_url"] = drive_url
            self.save()

    def delete_file(self, file_id: str):
        """파일 메타데이터 삭제"""
        if file_id in self._data:
            del self._data[file_id]
            self.save()

    def get_all_files(self) -> list:
        """모든 파일 목록 반환 (최신순)"""
        files = list(self._data.values())
        files.sort(key=lambda x: x.get("created", ""), reverse=True)
        return files

    def get_file(self, file_id: str) -> dict:
        """특정 파일 정보 반환"""
        return self._data.get(file_id)

    def sync_with_local_dir(self, directory: str):
        """로컬 폴더를 스캔하여 DB 동기화 (기존 DB 없는 파일 추가, 지워진 로컬 파일 처리)"""
        if not os.path.exists(directory):
            return

        local_files = []
        for root, dirs, files in os.walk(directory):
            for f in files:
                if f.endswith(".mp3"):
                    # 폴더 포함 상대 경로 생성
                    rel_path = os.path.relpath(os.path.join(root, f), directory)
                    local_files.append(rel_path)
        
        # 1. 로컬에 있는데 DB에 없으면 추가
        existing_filenames = [m["filename"] for m in self._data.values() if m["status"] == "LOCAL"]
        for f in local_files:
            if f not in existing_filenames:
                path = os.path.join(directory, f)
                stat = os.stat(path)
                self.add_local_file(
                    filename=f,
                    size_bytes=stat.st_size,
                    created_iso=datetime.fromtimestamp(stat.st_ctime).isoformat()
                )

        # 2. DB에는 LOCAL로 되어있는데 로컬에 없으면 삭제 (누군가 직접 지웠을 경우)
        to_delete = []
        for fid, meta in self._data.items():
            if meta["status"] == "LOCAL" and meta["filename"] not in local_files:
                to_delete.append(fid)
        
        for fid in to_delete:
            del self._data[fid]
            
        if to_delete or (len(local_files) > len(existing_filenames)):
            self.save()
