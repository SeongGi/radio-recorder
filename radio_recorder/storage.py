import os
import logging
from datetime import datetime
from smb.SMBConnection import SMBConnection
from smb.base import SharedFile
from smb.smb_structs import OperationFailure

logger = logging.getLogger(__name__)

class StorageManager:
    def __init__(self, config, file_tracker=None):
        self.config = config
        self.file_tracker = file_tracker

    def move_to_nas(self, local_rel_path: str):
        """파일을 NAS로 이동합니다."""
        nas_config = self.config.nas_config
        if not nas_config.get("server"):
            logger.warning("NAS 설정이 되어있지 않아 이동을 건너뜁니다.")
            return False

        recording_dir = self.config.recording_dir
        full_path = os.path.join(recording_dir, local_rel_path)
        if not os.path.exists(full_path):
            logger.error(f"NAS 이동 실패: 파일 없음 {full_path}")
            return False

        try:
            from smb.SMBConnection import SMBConnection
            import socket

            conn = SMBConnection(
                nas_config.get("username"),
                nas_config.get("password"),
                socket.gethostname(),
                nas_config.get("server"),
                use_ntlm_v2=True,
            )
            if not conn.connect(nas_config.get("server")):
                logger.error("NAS 연결 실패")
                return False

            filename = os.path.basename(local_rel_path)
            remote_dir = nas_config.get("remote_dir", "/").replace("/", "\\").strip("\\")
            remote_path = f"{remote_dir}\\{filename}" if remote_dir else filename

            with open(full_path, "rb") as f:
                conn.storeFile(nas_config.get("share"), remote_path, f)

            conn.close()
            
            # 이동 처리 (원본 삭제 및 상태 업데이트)
            os.remove(full_path)
            if self.file_tracker:
                meta = next((m for m in self.file_tracker.get_all_files() if m["filename"] == local_rel_path), None)
                if meta:
                    self.file_tracker.update_status(meta["id"], "NAS")
            
            logger.info(f"NAS 이동 완료: {local_rel_path}")
            return True
        except Exception as e:
            logger.error(f"NAS 이동 오류: {e}")
            return False

    def upload_to_drive(self, local_rel_path: str, refresh_token: str = None):
        """파일을 Google Drive로 업로드(이동)합니다."""
        if not self.config.google_client_id or not refresh_token:
            logger.warning("Google Drive 설정 또는 토큰이 없어 업로드를 건너뜁니다.")
            return False

        recording_dir = self.config.recording_dir
        full_path = os.path.join(recording_dir, local_rel_path)
        if not os.path.exists(full_path):
            return False

        try:
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build
            from googleapiclient.http import MediaFileUpload

            creds = Credentials(
                token=None,
                refresh_token=refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=self.config.google_client_id,
                client_secret=self.config.google_client_secret,
            )
            service = build("drive", "v3", credentials=creds)

            folder_name = self.config.drive_config.get("folder", "Radio Recordings")
            folder_query = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
            results = service.files().list(q=folder_query, fields="files(id)").execute()
            folders = results.get("files", [])
            
            if folders:
                folder_id = folders[0]["id"]
            else:
                folder_metadata = {"name": folder_name, "mimeType": "application/vnd.google-apps.folder"}
                folder = service.files().create(body=folder_metadata, fields="id").execute()
                folder_id = folder["id"]

            filename = os.path.basename(local_rel_path)
            file_metadata = {"name": filename, "parents": [folder_id]}
            media = MediaFileUpload(full_path, mimetype="audio/mpeg", resumable=True)
            drive_file = service.files().create(body=file_metadata, media_body=media, fields="id, webViewLink").execute()

            os.remove(full_path)
            if self.file_tracker:
                meta = next((m for m in self.file_tracker.get_all_files() if m["filename"] == local_rel_path), None)
                if meta:
                    self.file_tracker.update_status(meta["id"], "DRIVE", drive_url=drive_file.get("webViewLink"))
            
            logger.info(f"Google Drive 업로드 완료: {local_rel_path}")
            return True
        except Exception as e:
            logger.error(f"Google Drive 업로드 오류: {e}")
            return False
