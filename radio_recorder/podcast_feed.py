"""
Podcast RSS 피드 생성기
녹음된 파일을 Podcast RSS 피드로 제공합니다.
"""

import os
import logging
from datetime import datetime
from feedgen.feed import FeedGenerator

logger = logging.getLogger(__name__)


class PodcastFeed:
    """Podcast RSS 피드 생성기"""

    def __init__(self, config, file_tracker=None):
        self.config = config
        self.file_tracker = file_tracker

    def generate_feed(
        self,
        base_url: str,
        station_filter: str = None,
        limit: int = 100,
    ) -> str:
        """
        RSS 피드 XML을 생성합니다.

        Args:
            base_url: 서버의 외부 접근 URL (예: https://radio.example.com)
            station_filter: 특정 방송국만 필터 (예: "kbs_classic")
            limit: 최대 에피소드 수

        Returns:
            str: RSS XML 문자열
        """
        rss_token = self.config.rss_token
        # base_url 후속 슬래시 정리
        base_url = base_url.rstrip("/")
        
        feed_url = f"{base_url}/feed/rss?token={rss_token}"
        if station_filter:
            feed_url += f"&station={station_filter}"

        fg = FeedGenerator()
        fg.load_extension("podcast")

        # 피드 메타데이터
        if station_filter:
            station = self.config.get_station(station_filter)
            title = f"📻 {station['name']}" if station else f"📻 Radio - {station_filter}"
        else:
            title = "📻 Radio Recorder"

        fg.title(title)
        fg.link(href=feed_url, rel="self")
        fg.description("한국 라디오 예약 녹음 피드")
        fg.language("ko")
        fg.podcast.itunes_category("Music")
        fg.podcast.itunes_author("Radio Recorder")
        fg.podcast.itunes_explicit("no")

        # 녹음 파일 수집
        files = self._collect_files(station_filter, limit)

        for f in files:
            # 외부 링크 설정 시 base_url 명시
            full_url = f["url"] if f["url"].startswith("http") else f"{base_url}{f['url']}"
            
            fe = fg.add_entry()
            fe.id(full_url)
            fe.title(f["title"])
            fe.description(f"녹음일: {f['date']}")
            fe.published(f["published"])

            # 오디오 인클로저
            fe.enclosure(
                url=full_url,
                length=str(f["size"]),
                type="audio/mpeg",
            )

            if f.get("duration"):
                fe.podcast.itunes_duration(f["duration"])

        return fg.rss_str(pretty=True).decode("utf-8")

    def _collect_files(self, station_filter: str, limit: int) -> list[dict]:
        """녹음 파일 목록을 수집합니다. (FileTracker 우선)"""
        rss_token = self.config.rss_token
        files = []

        if self.file_tracker:
            # DB 메타데이터를 활용하여 NAS/DRIVE 전송 완료된 에피소드도 유지
            db_files = self.file_tracker.get_all_files()
            for f in db_files:
                filename = f["filename"]
                
                # 방송국 필터링
                if station_filter:
                    station = self.config.get_station(station_filter)
                    if station:
                        safe_name = station["name"].replace(" ", "_").replace("/", "-")
                        if safe_name not in filename:
                            continue

                status = f.get("status", "LOCAL")

                # URL 설정
                if status == "LOCAL":
                    url = f"/recordings/{filename}?token={rss_token}"
                elif status == "NAS":
                    url = f"/api/storage/nas/stream/{f['id']}?token={rss_token}"
                elif status == "DRIVE":
                    url = f"/api/storage/drive/stream/{f['id']}?token={rss_token}"
                else:
                    # TRANSFERRING 등 임시 전송 상태인 파일은 피드 제외
                    continue

                try:
                    pub_time = datetime.fromisoformat(f["created"])
                except Exception:
                    pub_time = datetime.now()

                name_part = os.path.splitext(os.path.basename(filename))[0]

                # 제목 접미사에 현재 파일 물리적 보관 상태 표기
                suffix = ""
                if status == "NAS":
                    suffix = " [NAS]"
                elif status == "DRIVE":
                    suffix = " [Google Drive]"

                files.append({
                    "filename": filename,
                    "title": name_part.replace("_", " ") + suffix,
                    "url": url,
                    "size": f.get("size_bytes", 0),
                    "date": pub_time.strftime("%Y-%m-%d %H:%M"),
                    "published": pub_time.timezone_set(None) if hasattr(pub_time, 'timezone_set') else pub_time,
                })
            
            # published 타임스탬프 기준으로 정렬 (tz-naive datetime)
            files.sort(key=lambda x: x["published"], reverse=True)
            
            # published를 timezone-aware datetime으로 보장하여 feedgen Extension 충돌 방지
            import pytz
            local_tz = pytz.timezone("Asia/Seoul")
            for f in files:
                if f["published"].tzinfo is None:
                    f["published"] = local_tz.localize(f["published"])
            
            return files[:limit]

        # Fallback: 로컬 스캔 방식
        recording_dir = self.config.recording_dir
        if not os.path.exists(recording_dir):
            return files

        for root, _, filenames in os.walk(recording_dir):
            for filename in filenames:
                if not filename.endswith((".mp3", ".aac", ".m4a")):
                    continue

                if station_filter:
                    station = self.config.get_station(station_filter)
                    if station:
                        safe_name = station["name"].replace(" ", "_").replace("/", "-")
                        if safe_name not in filename:
                            continue

                filepath = os.path.join(root, filename)
                relative_path = os.path.relpath(filepath, recording_dir)
                try:
                    stat = os.stat(filepath)
                    size = stat.st_size
                    mtime = datetime.fromtimestamp(stat.st_mtime)
                except Exception:
                    size = 0
                    mtime = datetime.now()

                name_part = os.path.splitext(filename)[0]

                files.append({
                    "filename": filename,
                    "title": name_part.replace("_", " "),
                    "url": f"/recordings/{relative_path}?token={rss_token}",
                    "size": size,
                    "date": mtime.strftime("%Y-%m-%d %H:%M"),
                    "published": mtime,
                })

        files.sort(key=lambda x: x["published"], reverse=True)
        import pytz
        local_tz = pytz.timezone("Asia/Seoul")
        for f in files:
            if f["published"].tzinfo is None:
                f["published"] = local_tz.localize(f["published"])
                
        return files[:limit]

    def get_feed_urls(self, base_url: str) -> dict:
        """
        사용 가능한 피드 URL 목록을 반환합니다.

        Returns:
            dict: {"all": url, "stations": {station_id: url}}
        """
        token = self.config.rss_token
        urls = {
            "all": f"{base_url}/feed/rss?token={token}",
            "stations": {},
        }

        for station_id in self.config.stations:
            urls["stations"][station_id] = (
                f"{base_url}/feed/rss?token={token}&station={station_id}"
            )

        return urls
