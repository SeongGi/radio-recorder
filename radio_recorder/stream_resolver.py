"""
스트림 URL 해석기
방송국 설정에서 실제 재생 가능한 HLS 스트림 URL을 획득합니다.
3단계 폴백: BSOD 프록시 → 직접 API → radio-browser.info
"""

import logging
import requests

logger = logging.getLogger(__name__)

# BSOD 프록시 기본 URL
BSOD_BASE_URL = "https://radio.bsod.kr/stream/"

# radio-browser.info API
RADIO_BROWSER_API = "https://de1.api.radio-browser.info"

# 방송사별 직접 API 엔드포인트 매핑
DIRECT_API_MAP = {
    "KBS": {
        "1radio": "https://1radio-bora.gscdn.kbs.co.kr/1radio-bora-01/1radio-bora-01_hd.m3u8",
        "2radio": "https://2radio-bora.gscdn.kbs.co.kr/2radio-bora-02/2radio-bora-02_hd.m3u8",
        "1fm": "https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8",
        "2fm": "https://2fm-ad.gscdn.kbs.co.kr/2fm_ad_192_1.m3u8",
    },
    "MBC": {
        "sfm": "https://minisw.imbc.com/dsfm/_definst_/sfm.stream/playlist.m3u8",
        "mfm": "https://minimw.imbc.com/dmfm/_definst_/mfm.stream/playlist.m3u8",
        "chm": "https://minicw.imbc.com/dchm/_definst_/chm.stream/playlist.m3u8",
    },
    "SBS": {
        "powerfm": "https://radiolive.sbs.co.kr/powerpc/powerfm.stream/playlist.m3u8",
        "lovefm": "https://radiolive.sbs.co.kr/lovepc/lovefm.stream/playlist.m3u8",
    },
    "TBS": {
        "tbs": "https://tbs.seoul.kr/live/traffic.m3u8",
        "efm": "https://tbs.seoul.kr/live/efm.m3u8",
    },
    "WBS": {
        "wbs": "https://wbs.mvod.cdn.vcloud.co.kr/wbs/seoul/playlist.m3u8",
    },
}

# 방송사별 Referer 헤더
REFERER_MAP = {
    "KBS": "https://radio.kbs.co.kr/",
    "MBC": "https://mini.imbc.com/",
    "SBS": "https://programs.sbs.co.kr/",
}

# radio-browser.info 에서의 방송국 이름 매핑
RADIO_BROWSER_NAME_MAP = {
    "kbs_1radio": "KBS 1R",
    "kbs_2radio": "KBS 1Radio",
    "kbs_classic": "KBS Classic FM",
    "kbs_cool": "KBS Cool FM",
    "mbc_standard": "MBC FM",
    "mbc_fm4u": "MBC FM4U",
    "mbc_allmusic": "MBC 올댓뮤직",
    "sbs_power": "SBS Power FM",
    "sbs_love": "SBS Love FM",
}


class StreamResolveError(Exception):
    """스트림 URL을 찾을 수 없을 때 발생"""
    pass


class StreamResolver:
    """방송국 설정에서 재생 가능한 스트림 URL을 해석합니다."""

    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": "RadioRecorder/1.0 (Personal Radio Recorder)"
        })

    def resolve(self, station_config: dict) -> dict:
        """
        방송국 설정에서 스트림 URL을 해석합니다.

        Returns:
            dict: {"url": str, "referer": str, "source": str}
        """
        station_id = station_config.get("id", "unknown")
        network = station_config.get("network", "").upper()
        source = station_config.get("stream_source", "bsod")
        params = station_config.get("stream_params", {})

        logger.info(f"스트림 해석 시작: {station_config.get('name', station_id)}")

        errors = []

        # 1단계: BSOD 프록시
        if source == "bsod":
            try:
                result = self._try_bsod(params, network)
                logger.info(f"BSOD 프록시 성공: {station_id}")
                return result
            except Exception as e:
                errors.append(f"BSOD: {e}")
                logger.warning(f"BSOD 프록시 실패: {e}")

        # 2단계: 직접 API
        try:
            result = self._try_direct_api(network, params)
            logger.info(f"직접 API 성공: {station_id}")
            return result
        except Exception as e:
            errors.append(f"Direct: {e}")
            logger.warning(f"직접 API 실패: {e}")

        # 3단계: radio-browser.info
        try:
            result = self._try_radio_browser(station_id)
            logger.info(f"radio-browser.info 성공: {station_id}")
            return result
        except Exception as e:
            errors.append(f"RadioBrowser: {e}")
            logger.warning(f"radio-browser.info 실패: {e}")

        raise StreamResolveError(
            f"모든 소스에서 스트림 URL 획득 실패 [{station_id}]: {'; '.join(errors)}"
        )

    def _try_bsod(self, params: dict, network: str) -> dict:
        """BSOD 프록시를 통해 스트림 URL을 획득합니다."""
        stn = params.get("stn", "")
        ch = params.get("ch", "")

        if not stn or not ch:
            raise ValueError("stream_params에 stn, ch가 필요합니다")

        url = f"{BSOD_BASE_URL}?stn={stn}&ch={ch}"

        # BSOD는 HLS 스트림을 직접 제공 (리다이렉트 또는 m3u8 반환)
        resp = self._session.head(url, allow_redirects=True, timeout=10)

        if resp.status_code == 200:
            # 최종 리다이렉트된 URL 사용
            final_url = resp.url if resp.url != url else url
            return {
                "url": final_url,
                "referer": "https://radio.bsod.kr/",
                "source": "bsod",
            }

        raise ConnectionError(f"BSOD 응답 오류: HTTP {resp.status_code}")

    def _try_direct_api(self, network: str, params: dict) -> dict:
        """방송사 직접 API로 스트림 URL을 획득합니다."""
        ch = params.get("ch", "")
        api_map = DIRECT_API_MAP.get(network, {})
        base_url = api_map.get(ch)

        if not base_url:
            raise ValueError(f"직접 API 매핑 없음: {network}/{ch}")

        # 연결 테스트
        referer = REFERER_MAP.get(network, "")
        headers = {}
        if referer:
            headers["Referer"] = referer

        resp = self._session.head(
            base_url, headers=headers, allow_redirects=True, timeout=10
        )

        if resp.status_code == 200:
            return {
                "url": resp.url if resp.url != base_url else base_url,
                "referer": referer,
                "source": "direct",
            }

        raise ConnectionError(f"직접 API 응답 오류: HTTP {resp.status_code}")

    def _try_radio_browser(self, station_id: str) -> dict:
        """radio-browser.info에서 스트림 URL을 조회합니다."""
        name = RADIO_BROWSER_NAME_MAP.get(station_id)
        if not name:
            raise ValueError(f"radio-browser.info 매핑 없음: {station_id}")

        resp = self._session.get(
            f"{RADIO_BROWSER_API}/json/stations/search",
            params={
                "name": name,
                "countrycode": "KR",
                "limit": 5,
                "order": "votes",
                "reverse": "true",
            },
            timeout=10,
        )

        if resp.status_code != 200:
            raise ConnectionError(f"radio-browser API 오류: HTTP {resp.status_code}")

        stations = resp.json()
        if not stations:
            raise ValueError(f"검색 결과 없음: {name}")

        # 가장 투표 수가 많고 lastcheckok인 스테이션 선택
        for station in stations:
            if station.get("lastcheckok") == 1:
                resolved_url = station.get("url_resolved") or station.get("url")
                if resolved_url:
                    return {
                        "url": resolved_url,
                        "referer": "",
                        "source": "radio-browser",
                    }

        # lastcheckok 관계없이 첫 번째 결과 사용
        first = stations[0]
        resolved_url = first.get("url_resolved") or first.get("url")
        if resolved_url:
            return {
                "url": resolved_url,
                "referer": "",
                "source": "radio-browser",
            }

        raise ValueError(f"유효한 스트림 URL 없음: {name}")

    def test_stream(self, station_config: dict) -> dict:
        """
        스트림 연결을 테스트합니다.

        Returns:
            dict: {"success": bool, "url": str, "source": str, "error": str|None}
        """
        try:
            result = self.resolve(station_config)
            # 실제 스트림 데이터 수신 테스트 (1초)
            headers = {}
            if result.get("referer"):
                headers["Referer"] = result["referer"]

            resp = self._session.get(
                result["url"],
                headers=headers,
                stream=True,
                timeout=10,
            )

            # 약간의 데이터를 읽어봄
            chunk = next(resp.iter_content(chunk_size=1024), None)
            resp.close()

            if chunk:
                return {
                    "success": True,
                    "url": result["url"],
                    "source": result["source"],
                    "error": None,
                }
            else:
                return {
                    "success": False,
                    "url": result["url"],
                    "source": result["source"],
                    "error": "데이터 수신 없음",
                }

        except Exception as e:
            return {
                "success": False,
                "url": "",
                "source": "",
                "error": str(e),
            }

    def test_all_stations(self, stations: dict) -> dict:
        """모든 방송국의 스트림 연결을 테스트합니다."""
        results = {}
        for station_id, station in stations.items():
            station_with_id = {**station, "id": station_id}
            results[station_id] = self.test_stream(station_with_id)
            status = "✅" if results[station_id]["success"] else "❌"
            logger.info(
                f"  {status} {station.get('name', station_id)}: "
                f"{results[station_id].get('source', 'N/A')} - "
                f"{results[station_id].get('error', 'OK')}"
            )
        return results
