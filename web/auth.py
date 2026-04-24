"""
Google OAuth 2.0 인증 모듈
"""

import os
import functools
import logging
from authlib.integrations.flask_client import OAuth
from flask import session, redirect, url_for, request, flash, abort

logger = logging.getLogger(__name__)

oauth = OAuth()


def init_oauth(app, config):
    """Flask 앱에 Google OAuth를 설정합니다."""
    oauth.init_app(app)

    oauth.register(
        name="google",
        client_id=config.google_client_id,
        client_secret=config.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )

    return oauth


def login_required(f):
    """Google OAuth 로그인 필수 데코레이터"""

    @functools.wraps(f)
    def decorated(*args, **kwargs):
        user = session.get("user")
        if not user:
            return redirect(url_for("auth_login"))
        return f(*args, **kwargs)

    return decorated


def check_rss_token(config):
    """RSS 피드용 토큰 인증 체크"""
    token = request.args.get("token", "")
    return token == config.rss_token


def register_auth_routes(app, config):
    """인증 관련 라우트를 등록합니다."""

    @app.route("/auth/login")
    def auth_login():
        """Google 로그인 페이지로 리다이렉트"""
        # OAuth 미설정 시 바이패스 (개발용)
        if not config.google_client_id:
            session["user"] = {
                "email": "dev@localhost",
                "name": "Developer",
                "picture": "",
            }
            return redirect(url_for("dashboard"))

        redirect_uri = url_for("auth_callback", _external=True)
        return oauth.google.authorize_redirect(redirect_uri)

    @app.route("/auth/callback")
    def auth_callback():
        """Google OAuth 콜백 처리"""
        try:
            token = oauth.google.authorize_access_token()
            userinfo = token.get("userinfo", {})

            email = userinfo.get("email", "")
            name = userinfo.get("name", "")
            picture = userinfo.get("picture", "")

            # 허용된 이메일 체크
            allowed = config.allowed_emails
            if allowed and email not in allowed:
                logger.warning(f"허용되지 않은 이메일 로그인 시도: {email}")
                return """
                <html><body style="background:#0a0a0a;color:#ff4444;
                font-family:sans-serif;display:flex;align-items:center;
                justify-content:center;height:100vh;">
                <div style="text-align:center;">
                <h1>⛔ 접근 거부</h1>
                <p>허용되지 않은 계정입니다: {}</p>
                <a href="/" style="color:#4a9eff;">돌아가기</a>
                </div></body></html>
                """.format(email), 403

            session["user"] = {
                "email": email,
                "name": name,
                "picture": picture,
            }

            logger.info(f"로그인 성공: {email}")
            return redirect(url_for("dashboard"))

        except Exception as e:
            logger.error(f"OAuth 콜백 오류: {e}")
            return redirect(url_for("auth_login"))

    @app.route("/auth/logout")
    def auth_logout():
        """로그아웃"""
        user = session.pop("user", None)
        if user:
            logger.info(f"로그아웃: {user.get('email')}")
        return redirect("/")

    @app.route("/auth/status")
    def auth_status():
        """인증 상태 확인 (API)"""
        user = session.get("user")
        if user:
            return {"authenticated": True, "user": user}
        return {"authenticated": False}, 401
