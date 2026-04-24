"""
Flask 웹 서버
대시보드 UI + REST API + RSS 피드를 제공합니다.
"""

import os
import uuid
import logging
from datetime import datetime
from flask import (
    Flask, render_template, request, jsonify,
    send_from_directory, session, redirect, url_for
)

from web.auth import init_oauth, login_required, check_rss_token, register_auth_routes

logger = logging.getLogger(__name__)


def create_app(config, stream_resolver, recorder, scheduler, podcast_feed):
    """Flask 앱을 생성합니다."""

    app = Flask(
        __name__,
        template_folder=os.path.join(os.path.dirname(__file__), "templates"),
        static_folder=os.path.join(os.path.dirname(__file__), "static"),
    )

    app.secret_key = config.secret_key

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
        return jsonify(recorder.get_recording_files())

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

    @app.route("/api/feed-urls")
    @login_required
    def api_feed_urls():
        """RSS 피드 URL 목록"""
        base_url = request.host_url.rstrip("/")
        return jsonify(podcast_feed.get_feed_urls(base_url))

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
