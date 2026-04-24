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

    def __init__(self, config):
        self.config = config

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
            fe = fg.add_entry()
            fe.id(f["url"])
            fe.title(f["title"])
            fe.description(f"녹음일: {f['date']}")
            fe.published(f["published"])

            # 오디오 인클로저
            fe.enclosure(
                url=f["url"],
                length=str(f["size"]),
                type="audio/mpeg",
            )

            if f.get("duration"):
                fe.podcast.itunes_duration(f["duration"])

        return fg.rss_str(pretty=True).decode("utf-8")

    def _collect_files(self, station_filter: str, limit: int) -> list[dict]:
        """녹음 파일 목록을 수집합니다."""
        recording_dir = self.config.recording_dir
        rss_token = self.config.rss_token
        files = []

        if not os.path.exists(recording_dir):
            return files

        for root, _, filenames in os.walk(recording_dir):
            for filename in filenames:
                if not filename.endswith((".mp3", ".aac", ".m4a")):
                    continue

                # 방송국 필터
                if station_filter:
                    station = self.config.get_station(station_filter)
                    if station:
                        safe_name = station["name"].replace(" ", "_").replace("/", "-")
                        if safe_name not in filename:
                            continue

                filepath = os.path.join(root, filename)
                relative_path = os.path.relpath(filepath, recording_dir)
                stat = os.stat(filepath)

                # 파일명에서 정보 추출
                name_part = os.path.splitext(filename)[0]

                files.append({
                    "filename": filename,
                    "title": name_part.replace("_", " "),
                    "url": f"/recordings/{relative_path}?token={rss_token}",
                    "size": stat.st_size,
                    "date": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M"),
                    "published": datetime.fromtimestamp(stat.st_mtime),
                    "duration": None,  # TODO: ffprobe로 정확한 길이 조회
                })

        # 최신순 정렬
        files.sort(key=lambda x: x["published"], reverse=True)
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
