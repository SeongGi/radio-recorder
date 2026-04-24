#!/usr/bin/env python3
"""
Radio Recorder - 엔트리포인트
한국 라디오 예약 녹음 프로그램

사용법:
    python run.py                                    # 서버 + 스케줄러 시작
    python run.py --test-streams                     # 스트림 연결 테스트
    python run.py --test-record kbs_classic -d 10    # 10초 테스트 녹음
"""

import os
import sys
import argparse
import logging
import uuid
from datetime import datetime

# 프로젝트 루트를 경로에 추가
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def setup_logging(level=logging.INFO):
    """로깅 설정"""
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # 외부 라이브러리 로깅 레벨 조정
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    logging.getLogger("apscheduler").setLevel(logging.WARNING)


def get_local_ip():
    """로컬 네트워크 IP를 반환합니다."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def cmd_test_streams(config):
    """모든 방송국 스트림 연결 테스트"""
    from radio_recorder.stream_resolver import StreamResolver

    resolver = StreamResolver()
    print("\n📡 스트림 연결 테스트\n" + "=" * 50)

    results = resolver.test_all_stations(config.stations)

    print("\n" + "=" * 50)
    ok = sum(1 for r in results.values() if r["success"])
    print(f"\n결과: {ok}/{len(results)} 연결 성공\n")

    return 0 if ok == len(results) else 1


def cmd_test_record(config, station_id, duration):
    """테스트 녹음"""
    from radio_recorder.stream_resolver import StreamResolver
    from radio_recorder.recorder import Recorder

    resolver = StreamResolver()
    recorder = Recorder(config)

    station = config.get_station(station_id)
    if not station:
        print(f"❌ 알 수 없는 방송국: {station_id}")
        print(f"사용 가능: {', '.join(config.stations.keys())}")
        return 1

    print(f"\n🎙️ 테스트 녹음: {station['name']} ({duration}초)")
    print("=" * 50)

    # 스트림 URL 획득
    print("📡 스트림 URL 획득 중...")
    try:
        stream_info = resolver.resolve(station)
        print(f"✅ URL: {stream_info['url'][:80]}...")
        print(f"   소스: {stream_info['source']}")
    except Exception as e:
        print(f"❌ 스트림 획득 실패: {e}")
        return 1

    # 녹음 시작
    print(f"\n🔴 녹음 시작 ({duration}초)...")
    job = recorder.start_recording(
        job_id=f"test_{uuid.uuid4().hex[:8]}",
        station_id=station_id,
        station_name=station["name"],
        stream_url=stream_info["url"],
        referer=stream_info.get("referer", ""),
        duration_seconds=duration,
    )

    # 완료 대기
    import time
    while job.status.value in ("pending", "recording"):
        time.sleep(1)
        elapsed = int((datetime.now() - (job.start_time or datetime.now())).total_seconds())
        print(f"\r  ⏺ {elapsed}초 / {duration}초 ({job.file_size / 1024:.0f}KB)", end="", flush=True)

    print()

    if job.status.value == "completed":
        print(f"\n✅ 녹음 완료!")
        print(f"   파일: {job.output_path}")
        print(f"   크기: {job.file_size / 1024 / 1024:.1f}MB")
        return 0
    else:
        print(f"\n❌ 녹음 실패: {job.error}")
        return 1


def cmd_run_server(config):
    """메인 서버 + 스케줄러 실행"""
    from radio_recorder.stream_resolver import StreamResolver
    from radio_recorder.recorder import Recorder
    from radio_recorder.scheduler import RecordingScheduler
    from radio_recorder.podcast_feed import PodcastFeed
    from web.app import create_app

    logger = logging.getLogger("radio_recorder")

    # 핵심 모듈 초기화
    resolver = StreamResolver()
    recorder = Recorder(config)
    scheduler = RecordingScheduler(config, resolver, recorder)
    podcast = PodcastFeed(config)

    # Flask 앱 생성
    app = create_app(config, resolver, recorder, scheduler, podcast)

    # 스케줄러 시작
    scheduler.start()

    # 서버 정보 출력
    local_ip = get_local_ip()
    port = config.server_port

    print("\n" + "=" * 55)
    print("  📻 Radio Recorder 시작")
    print("=" * 55)
    print(f"  🌐 로컬:    http://localhost:{port}")
    print(f"  🌐 네트워크: http://{local_ip}:{port}")
    print(f"  📁 녹음 저장: {config.recording_dir}")
    print(f"  📅 등록된 예약: {len(scheduler.get_schedules())}개")

    if config.google_client_id:
        print(f"  🔐 인증: Google OAuth")
    else:
        print(f"  ⚠️  인증: 바이패스 (OAuth 미설정 - 개발 모드)")

    rss_url = f"http://{local_ip}:{port}/feed/rss?token={config.rss_token}"
    print(f"  🎙️ RSS 피드: {rss_url}")
    print("=" * 55 + "\n")

    # Flask 서버 실행
    try:
        app.run(
            host=config.server_host,
            port=port,
            debug=False,
            use_reloader=False,
        )
    except KeyboardInterrupt:
        logger.info("서버 종료 중...")
    finally:
        scheduler.shutdown()
        logger.info("Radio Recorder 종료")


def main():
    parser = argparse.ArgumentParser(
        description="📻 Radio Recorder - 한국 라디오 예약 녹음",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--config", "-c",
        default="config.yaml",
        help="설정 파일 경로 (기본: config.yaml)",
    )

    parser.add_argument(
        "--test-streams",
        action="store_true",
        help="모든 방송국 스트림 연결 테스트",
    )

    parser.add_argument(
        "--test-record",
        metavar="STATION_ID",
        help="특정 방송국 테스트 녹음 (예: kbs_classic)",
    )

    parser.add_argument(
        "-d", "--duration",
        type=int,
        default=10,
        help="테스트 녹음 시간 (초, 기본: 10)",
    )

    parser.add_argument(
        "--debug",
        action="store_true",
        help="디버그 로깅 활성화",
    )

    args = parser.parse_args()

    # 로깅 설정
    setup_logging(logging.DEBUG if args.debug else logging.INFO)

    # 설정 로드
    from radio_recorder.config import Config
    config = Config(args.config)

    # 명령 실행
    if args.test_streams:
        sys.exit(cmd_test_streams(config))

    elif args.test_record:
        sys.exit(cmd_test_record(config, args.test_record, args.duration))

    else:
        cmd_run_server(config)


if __name__ == "__main__":
    main()
