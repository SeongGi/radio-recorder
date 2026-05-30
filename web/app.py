"""
Flask 웹 서버
대시보드 UI + REST API + RSS 피드를 제공합니다.
"""

import os
import uuid
import shutil
import logging
import requests
from datetime import datetime
from flask import (
    Flask, render_template, request, jsonify,
    send_from_directory, session, redirect, url_for, Response, stream_with_context
)

from web.auth import init_oauth, login_required, check_rss_token, register_auth_routes
from werkzeug.middleware.proxy_fix import ProxyFix

logger = logging.getLogger(__name__)


def run_nas_transfer_in_background(paths, action, nas, recording_dir, file_tracker):
    def worker():
        import uuid
        from smbprotocol.connection import Connection
        from smbprotocol.session import Session
        from smbprotocol.tree import TreeConnect
        from smbprotocol.open import Open, CreateDisposition, FileAttributes, \
            ShareAccess, CreateOptions, FilePipePrinterAccessMask

        try:
            # 1단계: 임시 전송 중(TRANSFERRING) 상태로 변경
            for rel_path in paths:
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                    if meta:
                        file_tracker.update_status(meta["id"], "TRANSFERRING")

            # SMB 연결
            conn = Connection(uuid.uuid4(), nas["server"], 445)
            conn.connect()
            sess = Session(conn, nas.get("username", ""), nas.get("password", ""))
            sess.connect()
            tree = TreeConnect(sess, f"\\\\{nas['server']}\\{nas['share']}")
            tree.connect()

            remote_dir = nas.get("remote_dir", "/").replace("/", "\\").strip("\\")

            for rel_path in paths:
                full_path = os.path.normpath(os.path.join(recording_dir, rel_path))
                meta = None
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                
                if not meta:
                    continue

                if not os.path.exists(full_path):
                    file_tracker.update_status(meta["id"], "LOCAL")
                    continue

                try:
                    filename = os.path.basename(rel_path)
                    remote_path = f"{remote_dir}\\{filename}" if remote_dir else filename

                    file_open = Open(tree, remote_path)
                    file_open.create(
                        desired_access=FilePipePrinterAccessMask.GENERIC_WRITE,
                        file_attributes=FileAttributes.FILE_ATTRIBUTE_NORMAL,
                        share_access=ShareAccess.FILE_SHARE_WRITE,
                        create_disposition=CreateDisposition.FILE_OVERWRITE_IF,
                        create_options=CreateOptions.FILE_NON_DIRECTORY_FILE,
                    )

                    with open(full_path, "rb") as f:
                        offset = 0
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            file_open.write(chunk, offset=offset)
                            offset += len(chunk)

                    file_open.close()

                    if action == "move":
                        os.remove(full_path)
                        file_tracker.update_status(meta["id"], "NAS")
                    else:
                        file_tracker.update_status(meta["id"], "LOCAL")

                except Exception as e:
                    logger.error(f"NAS 비동기 전송 에러 ({rel_path}): {e}")
                    file_tracker.update_status(meta["id"], "LOCAL")

            tree.disconnect()
            conn.disconnect()

        except Exception as e:
            logger.error(f"NAS 비동기 연결 실패: {e}")
            for rel_path in paths:
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                    if meta and meta.get("status") == "TRANSFERRING":
                        file_tracker.update_status(meta["id"], "LOCAL")

    import threading
    threading.Thread(target=worker, daemon=True).start()


def run_drive_upload_in_background(paths, folder_name, access_token, refresh_token, recording_dir, file_tracker, config):
    def worker():
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload

        try:
            # 1단계: 임시 전송 중(TRANSFERRING) 상태로 변경
            for rel_path in paths:
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                    if meta:
                        file_tracker.update_status(meta["id"], "TRANSFERRING")

            creds = Credentials(
                token=access_token,
                refresh_token=refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=config.google_client_id,
                client_secret=config.google_client_secret,
            )
            service = build("drive", "v3", credentials=creds)

            # 폴더 찾기 또는 생성
            folder_query = (
                f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' "
                f"and trashed=false"
            )
            results = service.files().list(q=folder_query, fields="files(id)").execute()
            folders = results.get("files", [])

            if folders:
                folder_id = folders[0]["id"]
            else:
                folder_metadata = {
                    "name": folder_name,
                    "mimeType": "application/vnd.google-apps.folder",
                }
                folder = service.files().create(body=folder_metadata, fields="id").execute()
                folder_id = folder["id"]

            for rel_path in paths:
                full_path = os.path.normpath(os.path.join(recording_dir, rel_path))
                meta = None
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                
                if not meta:
                    continue

                if not os.path.exists(full_path):
                    file_tracker.update_status(meta["id"], "LOCAL")
                    continue

                try:
                    filename = os.path.basename(rel_path)
                    file_metadata = {
                        "name": filename,
                        "parents": [folder_id],
                    }
                    media = MediaFileUpload(full_path, mimetype="audio/mpeg", resumable=True)
                    drive_file = service.files().create(
                        body=file_metadata, media_body=media, fields="id, webViewLink"
                    ).execute()
                    
                    # 업로드 성공 후 로컬 파일 삭제 (이동 처리)
                    os.remove(full_path)
                    
                    # Tracker 업데이트
                    file_tracker.update_status(meta["id"], "DRIVE", drive_url=drive_file.get("webViewLink"))

                except Exception as e:
                    logger.error(f"Drive 비동기 업로드 에러 ({rel_path}): {e}")
                    file_tracker.update_status(meta["id"], "LOCAL")

        except Exception as e:
            logger.error(f"Drive 비동기 연결 실패: {e}")
            for rel_path in paths:
                if file_tracker:
                    meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)
                    if meta and meta.get("status") == "TRANSFERRING":
                        file_tracker.update_status(meta["id"], "LOCAL")

    import threading
    threading.Thread(target=worker, daemon=True).start()


def create_app(config, stream_resolver, recorder, scheduler, podcast_feed, file_tracker=None):
    """Flask 앱을 생성합니다."""

    app = Flask(
        __name__,
        template_folder=os.path.join(os.path.dirname(__file__), "templates"),
        static_folder=os.path.join(os.path.dirname(__file__), "static"),
    )

    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=2, x_proto=2, x_host=2, x_prefix=2)

    app.secret_key = config.secret_key
    from datetime import timedelta
    app.permanent_session_lifetime = timedelta(days=30)

    # Google OAuth 초기화
    init_oauth(app, config)
    register_auth_routes(app, config)

    # =====================
    # 페이지 라우트
    # =====================

    @app.route("/")
    def index():
        user = session.get("user")
        if user:
            return redirect(url_for("dashboard"))
        return render_template("login.html")

    @app.route("/play/<file_id>")
    def play_page(file_id):
        """별도 재생 페이지"""
        if not file_tracker:
            return "Tracker not initialized", 500
        
        meta = file_tracker.get_file(file_id)
        if not meta:
            return "File not found", 404
            
        return render_template("player.html", meta=meta)

    @app.route("/dashboard")
    @login_required
    def dashboard():
        user = session.get("user", {})
        return render_template(
            "dashboard.html",
            user=user,
            stations=config.stations,
        )

    # =====================
    # REST API
    # =====================

    @app.route("/api/stations")
    @login_required
    def api_stations():
        """방송국 목록"""
        stations = {}
        for sid, s in config.stations.items():
            stations[sid] = {**s, "id": sid}
        return jsonify(stations)

    @app.route("/api/schedules", methods=["GET"])
    @login_required
    def api_get_schedules():
        """예약 목록"""
        return jsonify(scheduler.get_schedules())

    @app.route("/api/schedules", methods=["POST"])
    @login_required
    def api_add_schedule():
        """예약 추가"""
        data = request.json
        try:
            schedule_type = data.get("type", "recurring")

            if schedule_type == "onetime":
                result = scheduler.add_onetime_schedule(
                    station_id=data["station_id"],
                    start_datetime=data["start_datetime"],
                    duration_minutes=int(data["duration_minutes"]),
                    label=data.get("label", ""),
                )
            else:
                result = scheduler.add_schedule(
                    station_id=data["station_id"],
                    days=data.get("days", []),
                    start_time=data["start_time"],
                    duration_minutes=int(data["duration_minutes"]),
                    label=data.get("label", ""),
                    enabled=data.get("enabled", True),
                )
            return jsonify(result), 201
        except Exception as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/schedules/<schedule_id>", methods=["PUT"])
    @login_required
    def api_update_schedule(schedule_id):
        """예약 수정"""
        data = request.json
        result = scheduler.update_schedule(schedule_id, data)
        if result:
            return jsonify(result)
        return jsonify({"error": "예약을 찾을 수 없습니다"}), 404

    @app.route("/api/schedules/<schedule_id>", methods=["DELETE"])
    @login_required
    def api_delete_schedule(schedule_id):
        """예약 삭제"""
        if scheduler.delete_schedule(schedule_id):
            return jsonify({"success": True})
        return jsonify({"error": "예약을 찾을 수 없습니다"}), 404

    @app.route("/api/schedules/<schedule_id>/toggle", methods=["POST"])
    @login_required
    def api_toggle_schedule(schedule_id):
        """예약 활성화/비활성화 토글"""
        result = scheduler.toggle_schedule(schedule_id)
        if result:
            return jsonify(result)
        return jsonify({"error": "예약을 찾을 수 없습니다"}), 404

    @app.route("/api/record/start", methods=["POST"])
    @login_required
    def api_start_recording():
        """즉시 녹음 시작"""
        data = request.json
        station_id = data.get("station_id")
        duration_minutes = int(data.get("duration_minutes", 60))

        station = config.get_station(station_id)
        if not station:
            return jsonify({"error": "알 수 없는 방송국"}), 400

        try:
            # 스트림 URL 획득
            stream_info = stream_resolver.resolve(station)

            job_id = f"manual_{uuid.uuid4().hex[:8]}"
            job = recorder.start_recording(
                job_id=job_id,
                station_id=station_id,
                station_name=station["name"],
                stream_url=stream_info["url"],
                referer=stream_info.get("referer", ""),
                duration_seconds=duration_minutes * 60,
            )

            return jsonify(job.to_dict()), 201
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/record/stop/<job_id>", methods=["POST"])
    @login_required
    def api_stop_recording(job_id):
        """녹음 중지"""
        if recorder.cancel_recording(job_id):
            return jsonify({"success": True})
        return jsonify({"error": "녹음을 찾을 수 없습니다"}), 404

    @app.route("/api/record/status")
    @login_required
    def api_recording_status():
        """진행 중인 녹음 목록"""
        return jsonify(recorder.get_active_jobs())

    @app.route("/api/record/history")
    @login_required
    def api_recording_history():
        """녹음 기록"""
        limit = int(request.args.get("limit", 50))
        return jsonify(recorder.get_history(limit))

    @app.route("/api/files")
    @login_required
    def api_files():
        """녹음 파일 목록"""
        if file_tracker:
            # DB 동기화 후 반환
            file_tracker.sync_with_local_dir(config.recording_dir)
            files = file_tracker.get_all_files()
            # UI 호환성을 위해 relative_path 추가
            for f in files:
                f["relative_path"] = f["filename"]
                f["size_mb"] = round(f.get("size_bytes", 0) / (1024 * 1024), 2)
            return jsonify(files)
        return jsonify(recorder.get_recording_files())

    @app.route("/api/files", methods=["DELETE"])
    @login_required
    def api_delete_files():
        """파일 삭제 (단일/다중)"""
        data = request.json
        paths = data.get("paths", [])
        if not paths:
            return jsonify({"error": "삭제할 파일을 선택하세요"}), 400

        deleted = []
        errors = []
        recording_dir = config.recording_dir

        for rel_path in paths:
            # Tracker에서 메타데이터 찾기
            meta = None
            if file_tracker:
                meta = next((m for m in file_tracker.get_all_files() if m["filename"] == rel_path), None)

            # 로컬 파일인 경우
            if not meta or meta.get("status") == "LOCAL":
                full_path = os.path.normpath(os.path.join(recording_dir, rel_path))
                if not full_path.startswith(os.path.normpath(recording_dir)):
                    errors.append(f"잘못된 경로: {rel_path}")
                    continue

                if os.path.exists(full_path):
                    try:
                        os.remove(full_path)
                        deleted.append(rel_path)
                        if file_tracker and meta:
                            file_tracker.delete_file(meta["id"])
                    except Exception as e:
                        errors.append(f"{rel_path}: {e}")
                else:
                    # 파일은 없지만 Tracker에는 있을 수 있음
                    if file_tracker and meta:
                        file_tracker.delete_file(meta["id"])
                        deleted.append(rel_path)
                    else:
                        errors.append(f"파일 없음: {rel_path}")
            else:
                # NAS나 Drive의 경우 원격 삭제 로직 (일단 메타데이터만 삭제 처리)
                if file_tracker and meta:
                    file_tracker.delete_file(meta["id"])
                    deleted.append(rel_path)

        return jsonify({"deleted": deleted, "errors": errors})

    # =====================
    # NAS 연동 (SMB)
    # =====================

    @app.route("/api/storage/nas", methods=["GET"])
    @login_required
    def api_nas_config():
        """NAS 설정 조회"""
        nas = config.nas_config
        return jsonify({
            "server": nas.get("server", ""),
            "share": nas.get("share", ""),
            "username": nas.get("username", ""),
            "password": "***" if nas.get("password") else "",
            "remote_dir": nas.get("remote_dir", "/"),
        })

    @app.route("/api/storage/nas", methods=["POST"])
    @login_required
    def api_nas_config_save():
        """NAS 설정 저장"""
        data = request.json
        current = config.nas_config
        nas_data = {
            "server": data.get("server", ""),
            "share": data.get("share", ""),
            "username": data.get("username", ""),
            "password": data.get("password", "") if data.get("password") != "***" else current.get("password", ""),
            "remote_dir": data.get("remote_dir", "/"),
        }
        config.set_nas_config(nas_data)
        return jsonify({"success": True})

    @app.route("/api/storage/drive", methods=["GET"])
    @login_required
    def api_drive_config():
        """Drive 설정 조회"""
        return jsonify(config.drive_config)

    @app.route("/api/storage/drive", methods=["POST"])
    @login_required
    def api_drive_config_save():
        """Drive 설정 저장"""
        data = request.json
        drive_data = {
            "folder": data.get("folder", "Radio Recordings"),
        }
        config.set_drive_config(drive_data)
        return jsonify({"success": True})

    @app.route("/api/storage/drive/stream/<file_id>")
    def api_drive_stream(file_id):
        """Google Drive 파일 스트리밍 (리다이렉트)"""
        token = request.args.get("token", "")
        is_authenticated = (session.get("user") is not None) or (token == config.rss_token)
        if not is_authenticated:
            return "Unauthorized", 401

        if not file_tracker:
            return "File tracker not initialized", 500

        meta = file_tracker.get_file(file_id)
        if not meta or meta.get("status") != "DRIVE":
            return "File not found on Drive", 404

        drive_url = meta.get("drive_url")
        if not drive_url:
            return "Drive URL not found", 404

        return redirect(drive_url)

    @app.route("/api/storage/nas/stream/<file_id>")
    def api_nas_stream(file_id):
        """NAS 파일 스트리밍"""
        token = request.args.get("token", "")
        is_authenticated = (session.get("user") is not None) or (token == config.rss_token)
        if not is_authenticated:
            return "Unauthorized", 401

        if not file_tracker:
            return "File tracker not initialized", 500
            
        meta = file_tracker.get_file(file_id)
        if not meta or meta.get("status") != "NAS":
            return "File not found on NAS", 404
            
        nas = config.nas_config
        if not nas.get("server") or not nas.get("share"):
            return "NAS not configured", 500

        try:
            from smbprotocol.connection import Connection
            from smbprotocol.session import Session
            from smbprotocol.tree import TreeConnect
            from smbprotocol.open import Open, CreateDisposition, FileAttributes, \
                ShareAccess, CreateOptions, FilePipePrinterAccessMask

            conn = Connection(uuid.uuid4(), nas["server"], 445)
            conn.connect()
            sess = Session(conn, nas.get("username", ""), nas.get("password", ""))
            sess.connect()
            tree = TreeConnect(sess, f"\\\\{nas['server']}\\{nas['share']}")
            tree.connect()

            filename = os.path.basename(meta["filename"])
            remote_dir = nas.get("remote_dir", "/").replace("/", "\\").strip("\\")
            remote_path = f"{remote_dir}\\{filename}" if remote_dir else filename

            file_open = Open(tree, remote_path)
            file_open.create(
                desired_access=FilePipePrinterAccessMask.GENERIC_READ,
                file_attributes=FileAttributes.FILE_ATTRIBUTE_NORMAL,
                share_access=ShareAccess.FILE_SHARE_READ,
                create_disposition=CreateDisposition.FILE_OPEN,
                create_options=CreateOptions.FILE_NON_DIRECTORY_FILE,
            )

            def generate():
                try:
                    offset = 0
                    while True:
                        chunk = file_open.read(offset, 65536)
                        if not chunk:
                            break
                        yield chunk
                        offset += len(chunk)
                finally:
                    file_open.close()
                    tree.disconnect()
                    conn.disconnect()

            return Response(stream_with_context(generate()), mimetype="audio/mpeg")

        except Exception as e:
            logger.error(f"NAS Stream Error: {e}")
            return f"Error connecting to NAS: {e}", 502

    @app.route("/api/storage/nas/test", methods=["POST"])
    @login_required
    def api_nas_test():
        """NAS 연결 테스트"""
        nas = config.nas_config
        if not nas.get("server") or not nas.get("share"):
            return jsonify({"success": False, "error": "NAS 설정이 없습니다"}), 400
        try:
            from smbprotocol.connection import Connection
            from smbprotocol.session import Session

            conn = Connection(uuid.uuid4(), nas["server"], 445)
            conn.connect()
            s = Session(conn, nas.get("username", ""), nas.get("password", ""))
            s.connect()
            conn.disconnect()
            return jsonify({"success": True})
        except Exception as e:
            return jsonify({"success": False, "error": str(e)})

    @app.route("/api/storage/nas/transfer", methods=["POST"])
    @login_required
    def api_nas_transfer():
        """NAS로 파일 전송 (복사/이동)"""
        data = request.json
        paths = data.get("paths", [])
        action = data.get("action", "copy")  # copy or move

        nas = config.nas_config
        if not nas.get("server") or not nas.get("share"):
            return jsonify({"error": "NAS 설정을 먼저 완료하세요"}), 400

        recording_dir = config.recording_dir

        # 백그라운드 전송 기동
        run_nas_transfer_in_background(paths, action, nas, recording_dir, file_tracker)

        return jsonify({
            "status": "started",
            "message": f"{len(paths)}개 파일의 NAS 전송({action})을 백그라운드에서 시작했습니다.",
            "paths": paths
        })

    # =====================
    # Google Drive 연동
    # =====================

    @app.route("/api/storage/drive/upload", methods=["POST"])
    @login_required
    def api_drive_upload():
        """Google Drive로 파일 업로드"""
        data = request.json
        paths = data.get("paths", [])
        folder_name = data.get("folder", "Radio Recordings")

        access_token = session.get("google_access_token")
        refresh_token = session.get("google_refresh_token")

        # 세션에 refresh_token이 없고 파일에 백업이 있으면 로드
        if not refresh_token:
            import json
            if os.path.exists("data/google_tokens.json"):
                try:
                    with open("data/google_tokens.json", "r") as f:
                        saved = json.load(f)
                        refresh_token = saved.get("refresh_token")
                        if refresh_token:
                            session["google_refresh_token"] = refresh_token
                except Exception as e:
                    logger.error(f"Refresh token file load failed: {e}")

        if not access_token and not refresh_token:
            return jsonify({"error": "Google Drive 인증이 필요합니다. 재로그인 해주세요."}), 401

        # Token 유효성 및 리프레시 검사
        try:
            from google.oauth2.credentials import Credentials
            from google.auth.transport.requests import Request

            creds = Credentials(
                token=access_token,
                refresh_token=refresh_token,
                token_uri="https://oauth2.googleapis.com/token",
                client_id=config.google_client_id,
                client_secret=config.google_client_secret,
            )

            if not creds.valid:
                if creds.expired and creds.refresh_token:
                    logger.info("Drive Upload: access token expired, refreshing...")
                    creds.refresh(Request())
                    access_token = creds.token
                    session["google_access_token"] = access_token
                    # 파일 캐시도 업데이트
                    import json
                    try:
                        with open("data/google_tokens.json", "w") as f:
                            json.dump({"refresh_token": creds.refresh_token, "access_token": access_token}, f)
                    except Exception as e:
                        logger.error(f"Failed to update token file: {e}")
                else:
                    return jsonify({"error": "Google Drive 인증이 만료되었습니다. 재로그인 해주세요."}), 401
        except Exception as e:
            logger.error(f"Credentials validation error: {e}")
            return jsonify({"error": f"인증 검증 실패: {e}"}), 401

        recording_dir = config.recording_dir

        # 백그라운드 업로드 기동
        run_drive_upload_in_background(paths, folder_name, access_token, refresh_token, recording_dir, file_tracker, config)

        return jsonify({
            "status": "started",
            "message": f"{len(paths)}개 파일의 Google Drive 업로드를 백그라운드에서 시작했습니다.",
            "paths": paths
        })

    @app.route("/api/streams/test")
    @login_required
    def api_test_streams():
        """스트림 연결 테스트"""
        station_id = request.args.get("station")
        if station_id:
            station = config.get_station(station_id)
            if not station:
                return jsonify({"error": "알 수 없는 방송국"}), 400
            result = stream_resolver.test_stream(station)
            return jsonify({station_id: result})
        else:
            results = stream_resolver.test_all_stations(config.stations)
            return jsonify(results)

    @app.route("/api/config")
    @login_required
    def api_config():
        """설정 정보 (민감 정보 제외)"""
        return jsonify(config.to_dict())

    @app.route("/api/ad-detection")
    @login_required
    def api_ad_detection_status():
        """광고 감지 설정 상태"""
        return jsonify({
            "enabled": config.ad_detection_enabled,
            "config": {
                "silence_threshold_db": config.ad_detection_config.get("silence_threshold_db", -40),
                "silence_min_duration": config.ad_detection_config.get("silence_min_duration", 0.5),
                "loudness_jump_threshold": config.ad_detection_config.get("loudness_jump_threshold", 6),
            },
        })

    @app.route("/api/ad-detection/toggle", methods=["POST"])
    @login_required
    def api_ad_detection_toggle():
        """광고 감지 활성화/비활성화 토글"""
        current = config.ad_detection_enabled
        new_state = not current
        config.set_ad_detection_enabled(new_state)

        # Recorder의 ad_detector도 동기화
        if new_state and recorder._ad_detector is None:
            from radio_recorder.ad_detector import AdDetector
            recorder._ad_detector = AdDetector(config.ad_detection_config)
        elif not new_state:
            recorder._ad_detector = None

        return jsonify({"enabled": new_state})

    @app.route("/api/feed-urls")
    @login_required
    def api_feed_urls():
        """RSS 피드 URL 목록"""
        base_url = request.host_url.rstrip("/")
        return jsonify(podcast_feed.get_feed_urls(base_url))

    @app.route("/api/stream-url/<station_id>")
    @login_required
    def api_stream_url(station_id):
        """라이브 스트림 URL 반환 (클라이언트 직접 재생용)"""
        station = config.get_station(station_id)
        if not station:
            return jsonify({"error": "알 수 없는 방송국"}), 400
        try:
            stream_info = stream_resolver.resolve(station)
            return jsonify({
                "url": stream_info["url"],
                "name": station["name"],
                "source": stream_info.get("source", ""),
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/stream/<station_id>")
    @login_required
    def live_stream_proxy(station_id):
        """라이브 라디오 스트림 프록시 (오디오 바이트를 중계)"""
        station = config.get_station(station_id)
        if not station:
            return jsonify({"error": "알 수 없는 방송국"}), 404
        try:
            stream_info = stream_resolver.resolve(station)
            stream_url = stream_info["url"]
            referer = stream_info.get("referer", "")

            headers = {
                "User-Agent": "Mozilla/5.0 (compatible; RadioRecorder/1.0)",
                "Icy-MetaData": "0",
            }
            if referer:
                headers["Referer"] = referer

            upstream = requests.get(stream_url, stream=True, timeout=10, headers=headers)

            content_type = upstream.headers.get("Content-Type", "audio/mpeg")

            def generate():
                try:
                    for chunk in upstream.iter_content(chunk_size=4096):
                        if chunk:
                            yield chunk
                except Exception:
                    pass

            return Response(
                stream_with_context(generate()),
                content_type=content_type,
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                },
            )
        except Exception as e:
            logger.error(f"라이브 스트림 오류 [{station_id}]: {e}")
            return jsonify({"error": str(e)}), 502

    # =====================
    # 파일 다운로드
    # =====================

    @app.route("/recordings/<path:filepath>")
    def serve_recording(filepath):
        """녹음 파일 다운로드 (로그인 또는 RSS 토큰)"""
        user = session.get("user")
        has_token = check_rss_token(config)

        if not user and not has_token:
            return jsonify({"error": "인증 필요"}), 401

        recording_dir = config.recording_dir
        return send_from_directory(recording_dir, filepath, as_attachment=True)

    # =====================
    # RSS 피드 (토큰 인증)
    # =====================

    @app.route("/feed/rss")
    def rss_feed():
        """Podcast RSS 피드 (토큰 인증)"""
        if not check_rss_token(config):
            return jsonify({"error": "유효하지 않은 토큰"}), 401

        station = request.args.get("station")
        base_url = request.host_url.rstrip("/")

        xml = podcast_feed.generate_feed(
            base_url=base_url,
            station_filter=station,
        )

        return xml, 200, {"Content-Type": "application/rss+xml; charset=utf-8"}

    # =====================
    # PWA
    # =====================

    @app.route("/manifest.json")
    def pwa_manifest():
        return send_from_directory(
            os.path.join(os.path.dirname(__file__), "static"),
            "manifest.json",
            mimetype="application/manifest+json",
        )

    @app.route("/sw.js")
    def pwa_sw():
        return send_from_directory(
            os.path.join(os.path.dirname(__file__), "static"),
            "sw.js",
            mimetype="application/javascript",
        )

    # =====================
    # 에러 핸들러
    # =====================

    @app.errorhandler(404)
    def not_found(e):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Not found"}), 404
        return render_template("login.html"), 404

    @app.errorhandler(500)
    def server_error(e):
        return jsonify({"error": "Internal server error"}), 500

    return app
