"""
광고 감지 및 제거 모듈 (실험적)
녹음된 오디오 파일에서 광고 구간을 탐지하고 제거합니다.
"""

import os
import re
import json
import subprocess
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class AudioSegment:
    """오디오 구간"""
    start: float  # 초
    end: float    # 초
    is_ad: bool = False
    reason: str = ""


class AdDetector:
    """
    광고 감지기 (실험적)

    전략:
    1. FFmpeg silencedetect로 무음 구간 탐지
    2. 무음 구간 사이 세그먼트의 LUFS(평균 음량) 분석
    3. 본편과 음량 차이가 큰 구간을 광고로 추정
    4. 전형적 광고 길이 패턴 (15초, 30초 단위) 참고
    """

    def __init__(self, config: dict):
        self.silence_threshold_db = config.get("silence_threshold_db", -40)
        self.silence_min_duration = config.get("silence_min_duration", 0.5)
        self.loudness_jump_threshold = config.get("loudness_jump_threshold", 6)

    def detect_ads(self, audio_path: str) -> list[AudioSegment]:
        """
        오디오 파일에서 광고 구간을 탐지합니다.

        Returns:
            list[AudioSegment]: 탐지된 모든 구간 (is_ad=True/False)
        """
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"파일을 찾을 수 없습니다: {audio_path}")

        logger.info(f"광고 감지 시작: {os.path.basename(audio_path)}")

        # 1. 무음 구간 탐지
        silence_ranges = self._detect_silence(audio_path)
        logger.debug(f"무음 구간 {len(silence_ranges)}개 발견")

        # 2. 무음 기준으로 세그먼트 분할
        total_duration = self._get_duration(audio_path)
        segments = self._split_by_silence(silence_ranges, total_duration)

        if len(segments) < 3:
            logger.info("세그먼트가 너무 적어 광고 감지를 건너뜁니다.")
            return segments

        # 3. 각 세그먼트의 LUFS 분석
        for seg in segments:
            seg_lufs = self._get_lufs(audio_path, seg.start, seg.end)
            seg.lufs = seg_lufs

        # 4. 본편 음량 기준 계산 (중앙값 사용)
        lufs_values = [s.lufs for s in segments if hasattr(s, "lufs") and s.lufs is not None]
        if not lufs_values:
            return segments

        lufs_values.sort()
        median_lufs = lufs_values[len(lufs_values) // 2]

        # 5. 광고 판정
        for seg in segments:
            duration = seg.end - seg.start
            lufs = getattr(seg, "lufs", None)

            reasons = []

            # 음량 급변 체크
            if lufs is not None and abs(lufs - median_lufs) > self.loudness_jump_threshold:
                reasons.append(f"음량 차이: {abs(lufs - median_lufs):.1f} LUFS")

            # 전형적 광고 길이 (15초 또는 30초 단위)
            if 14 <= duration <= 16 or 29 <= duration <= 31:
                reasons.append(f"전형적 광고 길이: {duration:.0f}초")
            elif 44 <= duration <= 46 or 59 <= duration <= 61:
                reasons.append(f"전형적 광고 길이: {duration:.0f}초")

            if reasons:
                seg.is_ad = True
                seg.reason = "; ".join(reasons)

        ad_count = sum(1 for s in segments if s.is_ad)
        logger.info(f"광고 감지 완료: {ad_count}개 구간 추정")

        return segments

    def remove_ads(self, audio_path: str, output_path: str = None) -> str | None:
        """
        광고를 제거한 클린 버전을 생성합니다.

        Returns:
            str: 클린 파일 경로, 또는 광고가 없으면 None
        """
        segments = self.detect_ads(audio_path)
        content_segments = [s for s in segments if not s.is_ad]

        if len(content_segments) == len(segments):
            logger.info("광고가 감지되지 않았습니다.")
            return None

        if output_path is None:
            base, ext = os.path.splitext(audio_path)
            output_path = f"{base}_clean{ext}"

        # FFmpeg concat filter로 비광고 구간만 결합
        filter_parts = []
        for i, seg in enumerate(content_segments):
            filter_parts.append(
                f"[0:a]atrim=start={seg.start}:end={seg.end},asetpts=PTS-STARTPTS[a{i}]"
            )

        concat_inputs = "".join(f"[a{i}]" for i in range(len(content_segments)))
        filter_complex = ";".join(filter_parts) + f";{concat_inputs}concat=n={len(content_segments)}:v=0:a=1[out]"

        cmd = [
            "ffmpeg", "-y",
            "-i", audio_path,
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-acodec", "libmp3lame",
            "-ab", "192k",
            output_path,
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0:
                orig_size = os.path.getsize(audio_path)
                clean_size = os.path.getsize(output_path)
                removed_pct = (1 - clean_size / orig_size) * 100
                logger.info(
                    f"클린 버전 생성: {os.path.basename(output_path)} "
                    f"({removed_pct:.0f}% 감소)"
                )
                return output_path
            else:
                logger.error(f"클린 버전 생성 실패: {result.stderr[-300:]}")
                return None
        except Exception as e:
            logger.error(f"광고 제거 중 오류: {e}")
            return None

    def _detect_silence(self, audio_path: str) -> list[tuple[float, float]]:
        """FFmpeg silencedetect로 무음 구간을 탐지합니다."""
        cmd = [
            "ffmpeg",
            "-i", audio_path,
            "-af", f"silencedetect=noise={self.silence_threshold_db}dB:d={self.silence_min_duration}",
            "-f", "null", "-",
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        stderr = result.stderr

        # 파싱: silence_start / silence_end
        starts = re.findall(r"silence_start:\s*([\d.]+)", stderr)
        ends = re.findall(r"silence_end:\s*([\d.]+)", stderr)

        ranges = []
        for s, e in zip(starts, ends):
            ranges.append((float(s), float(e)))

        return ranges

    def _split_by_silence(
        self, silence_ranges: list[tuple[float, float]], total_duration: float
    ) -> list[AudioSegment]:
        """무음 구간을 기준으로 오디오를 세그먼트로 분할합니다."""
        if not silence_ranges:
            return [AudioSegment(start=0, end=total_duration)]

        segments = []
        prev_end = 0

        for sil_start, sil_end in silence_ranges:
            if sil_start > prev_end + 1:  # 최소 1초 이상인 세그먼트만
                segments.append(AudioSegment(start=prev_end, end=sil_start))
            prev_end = sil_end

        # 마지막 세그먼트
        if total_duration > prev_end + 1:
            segments.append(AudioSegment(start=prev_end, end=total_duration))

        return segments

    def _get_duration(self, audio_path: str) -> float:
        """오디오 파일의 총 길이(초)를 반환합니다."""
        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "json",
            audio_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])

    def _get_lufs(self, audio_path: str, start: float, end: float) -> float | None:
        """특정 구간의 LUFS(평균 음량)를 측정합니다."""
        duration = end - start
        if duration < 1:
            return None

        cmd = [
            "ffmpeg",
            "-ss", str(start),
            "-t", str(duration),
            "-i", audio_path,
            "-af", "loudnorm=print_format=json",
            "-f", "null", "-",
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            # LUFS 값 파싱
            match = re.search(r'"input_i"\s*:\s*"(-?[\d.]+)"', result.stderr)
            if match:
                return float(match.group(1))
        except Exception:
            pass

        return None
