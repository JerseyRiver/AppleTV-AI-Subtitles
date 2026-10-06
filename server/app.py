#!/usr/bin/env python3
"""AppleTV AI Subtitles gateway. Copyright 2026 JerseyRiver. Apache-2.0."""

from __future__ import annotations

import fcntl
import hashlib
import html
import io
import json
import logging
import os
import re
import shutil
import struct
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from difflib import SequenceMatcher
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from statistics import median
from typing import Any


APP_VERSION = "0.11.1"
ALIGNMENT_VERSION = 6
APPLE_MEDIA_TIME_OFFSET_MS = 10_000
PARAGRAPH_GAP_MS = 900
VTT_TIMESTAMP_MAP = "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000"
LOG = logging.getLogger("apple-subtitles")
TIMING_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}:\d{2}[,.]\d{3})(?P<settings>[^\r\n]*)"
)
HTML_TAG_RE = re.compile(r"<[^>]+>")
ASS_TAG_RE = re.compile(r"\{\\[^}]+\}")


class GatewayError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_GATEWAY):
        super().__init__(message)
        self.status = int(status)


@dataclass(frozen=True)
class Config:
    bind: str
    port: int
    access_token: str
    cache_dir: Path
    subdl_api_key: str
    gemini_api_key: str
    gemini_model: str
    gemini_batch_size: int
    gemini_concurrency: int
    timeout_seconds: int
    max_cache_entries: int
    chinese_languages: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "Config":
        cache_dir = Path(os.getenv("CACHE_DIR", "/var/lib/apple-subtitles/cache"))
        token = os.getenv("ACCESS_TOKEN", "").strip()
        if not token:
            raise SystemExit("ACCESS_TOKEN is required")
        return cls(
            bind=os.getenv("BIND", "127.0.0.1"),
            port=int(os.getenv("PORT", "8765")),
            access_token=token,
            cache_dir=cache_dir,
            subdl_api_key=os.getenv("SUBDL_API_KEY", "").strip(),
            gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
            gemini_model=os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip(),
            gemini_batch_size=max(20, min(400, int(os.getenv("GEMINI_BATCH_SIZE", "220")))),
            gemini_concurrency=max(1, min(4, int(os.getenv("GEMINI_CONCURRENCY", "3")))),
            timeout_seconds=max(10, min(180, int(os.getenv("HTTP_TIMEOUT_SECONDS", "60")))),
            max_cache_entries=max(20, min(1000, int(os.getenv("MAX_CACHE_ENTRIES", "200")))),
            chinese_languages=tuple(
                item.strip().lower()
                for item in os.getenv("SUBDL_CHINESE_LANGUAGES", "zh").split(",")
                if item.strip()
            ),
        )


@dataclass
class Cue:
    start_ms: int
    end_ms: int
    text: str
    settings: str = ""


@dataclass(frozen=True)
class CaptionSample:
    start_ms: int
    text: str
    end_ms: int | None = None


@dataclass(frozen=True)
class Alignment:
    scale: float
    offset_ms: float
    matches: int
    residual_ms: float
    confidence: float
    mode: str
    anchors: tuple[tuple[int, float], ...] = ()
    p80_residual_ms: float = 0.0
    coverage_ms: int = 0
    evidence_matches: int = 0


@dataclass(frozen=True)
class MediaRequest:
    asset_id: str
    title: str
    year: int | None
    duration: float
    media_type: str
    season: int | None
    episode: int | None
    discontinuity_sequence: int
    frame_rate: float | None = None

    @classmethod
    def from_query(cls, asset_id: str, query: dict[str, list[str]]) -> "MediaRequest":
        title = first(query, "title").strip()
        if not re.fullmatch(r"\d{4,20}", asset_id):
            raise GatewayError("invalid asset id", HTTPStatus.BAD_REQUEST)
        if not title or len(title) > 180:
            raise GatewayError("missing or invalid title", HTTPStatus.BAD_REQUEST)
        year = parse_int(first(query, "year"), 1880, 2200)
        duration = parse_float(first(query, "duration"), 30.0, 86400.0) or 21600.0
        media_type = first(query, "type").lower() or "movie"
        media_type = "tv" if media_type in {"tv", "show", "episode"} else "movie"
        return cls(
            asset_id=asset_id,
            title=title,
            year=year,
            duration=duration,
            media_type=media_type,
            season=parse_int(first(query, "season"), 1, 999),
            episode=parse_int(first(query, "episode"), 1, 9999),
            discontinuity_sequence=parse_int(first(query, "discontinuity"), 0, 100) or 0,
            frame_rate=parse_float(first(query, "frame_rate"), 15.0, 120.0),
        )


def first(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key) or []
    return str(values[0]) if values else ""


def parse_int(value: str, minimum: int, maximum: int) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if minimum <= parsed <= maximum else None


def parse_float(value: str, minimum: float, maximum: float) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if minimum <= parsed <= maximum else None


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    return "".join(ch for ch in value if ch.isalnum())


def timestamp_to_ms(value: str) -> int:
    hours, minutes, tail = value.replace(",", ".").split(":")
    seconds, millis = tail.split(".")
    return (((int(hours) * 60) + int(minutes)) * 60 + int(seconds)) * 1000 + int(millis)


def ms_to_timestamp(value: int) -> str:
    value = max(0, int(value))
    hours, rem = divmod(value, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def decode_subtitle(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "gb18030", "big5", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def clean_text(value: str) -> str:
    value = value.replace("\\N", "\n").replace("\\n", "\n")
    value = ASS_TAG_RE.sub("", value)
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    value = HTML_TAG_RE.sub("", value)
    value = html.unescape(value)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def parse_srt_or_vtt(text: str) -> list[Cue]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    matches = list(TIMING_RE.finditer(text))
    cues: list[Cue] = []
    for index, match in enumerate(matches):
        content_start = text.find("\n", match.end())
        if content_start < 0:
            continue
        content_end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        raw = text[content_start + 1 : content_end].strip()
        raw = re.sub(r"\n\s*\d+\s*$", "", raw).strip()
        cue_text = clean_text(raw)
        if cue_text:
            cues.append(
                Cue(
                    timestamp_to_ms(match.group("start")),
                    timestamp_to_ms(match.group("end")),
                    cue_text,
                    match.group("settings").strip(),
                )
            )
    return cues


def ass_time_to_ms(value: str) -> int:
    hours, minutes, tail = value.strip().split(":")
    seconds, centis = tail.split(".")
    return (((int(hours) * 60) + int(minutes)) * 60 + int(seconds)) * 1000 + int(centis) * 10


def parse_ass(text: str) -> list[Cue]:
    cues: list[Cue] = []
    in_events = False
    format_fields: list[str] = []
    for raw_line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if line.startswith("["):
            in_events = line.casefold() == "[events]"
            continue
        if not in_events:
            continue
        if line.casefold().startswith("format:"):
            format_fields = [part.strip().casefold() for part in line.split(":", 1)[1].split(",")]
            continue
        if not line.casefold().startswith("dialogue:") or not format_fields:
            continue
        values = line.split(":", 1)[1].lstrip().split(",", len(format_fields) - 1)
        if len(values) != len(format_fields):
            continue
        row = dict(zip(format_fields, values))
        try:
            cue_text = clean_text(row.get("text", ""))
            if cue_text:
                cues.append(Cue(ass_time_to_ms(row["start"]), ass_time_to_ms(row["end"]), cue_text))
        except (KeyError, ValueError):
            continue
    return cues


def parse_subtitle(data: bytes, name: str) -> list[Cue]:
    text = decode_subtitle(data)
    suffix = Path(name).suffix.casefold()
    cues = parse_ass(text) if suffix in {".ass", ".ssa"} else parse_srt_or_vtt(text)
    if not cues:
        raise GatewayError(f"subtitle parser found no cues in {name}")
    return cues


def render_vtt(cues: list[Cue], offset_ms: int = 0) -> str:
    lines = ["WEBVTT", VTT_TIMESTAMP_MAP, ""]
    for cue in cues:
        start = max(0, cue.start_ms + offset_ms)
        end = max(start + 1, cue.end_ms + offset_ms)
        settings = f" {cue.settings}" if cue.settings else ""
        lines.extend([f"{ms_to_timestamp(start)} --> {ms_to_timestamp(end)}{settings}", cue.text, ""])
    return "\n".join(lines)


def ensure_vtt_timestamp_map(vtt: str) -> str:
    """Add Apple's HLS media-time mapping to legacy cached WebVTT files."""
    if VTT_TIMESTAMP_MAP in vtt:
        return vtt
    if vtt.startswith("WEBVTT\r\n"):
        return f"WEBVTT\r\n{VTT_TIMESTAMP_MAP}\r\n{vtt[8:]}"
    if vtt.startswith("WEBVTT\n"):
        return f"WEBVTT\n{VTT_TIMESTAMP_MAP}\n{vtt[7:]}"
    return vtt


def canonicalize_apple_url(value: str) -> str:
    """Convert Loon-only playback aliases to Apple's public origin names."""
    parsed = urllib.parse.urlsplit(value.strip())
    aliases = {
        "play-cdn.itunes.apple.com": "play.itunes.apple.com",
        "play-edge-cdn.itunes.apple.com": "play-edge.itunes.apple.com",
    }
    hostname = aliases.get((parsed.hostname or "").casefold(), (parsed.hostname or "").casefold())
    allowed = hostname in {
        "play.itunes.apple.com",
        "play-edge.itunes.apple.com",
        "hls.itunes.apple.com",
        "hls-svod.itunes.apple.com",
    } or hostname.endswith(".tv.apple.com")
    if parsed.scheme != "https" or not allowed or parsed.username or parsed.password or parsed.port:
        raise GatewayError("invalid Apple playback reference", HTTPStatus.BAD_REQUEST)
    return urllib.parse.urlunsplit(("https", hostname, parsed.path, parsed.query, ""))


def mp4_boxes(data: bytes, start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    cursor = start
    while cursor + 8 <= end:
        size = struct.unpack_from(">I", data, cursor)[0]
        kind = data[cursor + 4 : cursor + 8]
        header = 8
        if size == 1 and cursor + 16 <= end:
            size = struct.unpack_from(">Q", data, cursor + 8)[0]
            header = 16
        elif size == 0:
            size = end - cursor
        if size < header or cursor + size > end:
            break
        yield cursor, cursor + size, kind, cursor + header
        cursor += size


def mp4_fullbox(data: bytes, payload: int) -> tuple[int, int, int]:
    value = struct.unpack_from(">I", data, payload)[0]
    return value >> 24, value & 0xFFFFFF, payload + 4


def cea608_text(sample: bytes) -> str:
    if len(sample) < 8 or sample[4:8] != b"cdat":
        return ""
    declared = struct.unpack_from(">I", sample, 0)[0]
    sample = sample[8 : min(len(sample), declared)]
    output: list[str] = []
    for index in range(0, len(sample) - 1, 2):
        left, right = sample[index] & 0x7F, sample[index + 1] & 0x7F
        if 0x10 <= left <= 0x1F:
            continue
        for value in (left, right):
            if 0x20 <= value <= 0x7E:
                output.append(chr(value))
    return "".join(output).strip()


def fragment_caption_samples(data: bytes) -> list[CaptionSample]:
    """Read CEA-608 cdat samples from Apple's fragmented MP4 without decoding video."""
    output: list[CaptionSample] = []
    for moof_start, moof_end, moof_kind, moof_payload in mp4_boxes(data):
        if moof_kind != b"moof":
            continue
        for _, traf_end, traf_kind, traf_payload in mp4_boxes(data, moof_payload, moof_end):
            if traf_kind != b"traf":
                continue
            children = list(mp4_boxes(data, traf_payload, traf_end))
            tfhd = next((box for box in children if box[2] == b"tfhd"), None)
            tfdt = next((box for box in children if box[2] == b"tfdt"), None)
            if not tfhd or not tfdt:
                continue
            _, flags, cursor = mp4_fullbox(data, tfhd[3])
            cursor += 4  # track_ID
            if flags & 0x1:
                cursor += 8
            if flags & 0x2:
                cursor += 4
            default_duration = struct.unpack_from(">I", data, cursor)[0] if flags & 0x8 else 0
            cursor += 4 if flags & 0x8 else 0
            default_size = struct.unpack_from(">I", data, cursor)[0] if flags & 0x10 else 0

            version, _, cursor = mp4_fullbox(data, tfdt[3])
            decode_time = struct.unpack_from(">Q" if version else ">I", data, cursor)[0]
            for trun in (box for box in children if box[2] == b"trun"):
                _, trun_flags, cursor = mp4_fullbox(data, trun[3])
                count = struct.unpack_from(">I", data, cursor)[0]
                cursor += 4
                data_offset = None
                if trun_flags & 0x1:
                    data_offset = struct.unpack_from(">i", data, cursor)[0]
                    cursor += 4
                if trun_flags & 0x4:
                    cursor += 4
                rows: list[tuple[int, int]] = []
                for _ in range(count):
                    duration, size = default_duration, default_size
                    if trun_flags & 0x100:
                        duration = struct.unpack_from(">I", data, cursor)[0]
                        cursor += 4
                    if trun_flags & 0x200:
                        size = struct.unpack_from(">I", data, cursor)[0]
                        cursor += 4
                    if trun_flags & 0x400:
                        cursor += 4
                    if trun_flags & 0x800:
                        cursor += 4
                    rows.append((duration, size))
                if data_offset is None:
                    decode_time += sum(duration for duration, _ in rows)
                    continue
                sample_offset = moof_start + data_offset
                for duration, size in rows:
                    sample = data[sample_offset : sample_offset + size]
                    text = cea608_text(sample)
                    if text:
                        output.append(CaptionSample(int(decode_time), text, int(decode_time + duration)))
                    decode_time += duration
                    sample_offset += size
    return output


def normalize_dialogue(value: str) -> str:
    value = re.sub(r"\[[^]]*]|\([^)]*\)", " ", value)
    value = re.sub(r"^[A-Z][A-Z .'-]{1,24}:\s*", "", value.strip())
    value = unicodedata.normalize("NFKD", value).casefold()
    value = "".join(ch if ch.isalnum() else " " for ch in value)
    return " ".join(value.split())


def dialogue_similarity(left: str, right: str) -> float:
    left, right = normalize_dialogue(left), normalize_dialogue(right)
    if min(len(left), len(right)) < 7:
        return 0.0
    if left in right or right in left:
        containment = min(len(left), len(right)) / max(len(left), len(right))
        if containment >= 0.65:
            return 0.92 + 0.08 * containment
    sequence = SequenceMatcher(None, left, right, autojunk=False).ratio()
    left_tokens, right_tokens = set(left.split()), set(right.split())
    token_score = len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))
    return max(sequence, 0.55 * sequence + 0.45 * token_score)


def dialogue_prefix_similarity(left: str, right: str) -> float:
    """Score whether two captions begin with the same spoken phrase.

    CEA-608 often emits a long sentence as several small pop-on captions.  A
    continuation may match the text of an external cue perfectly, but its
    timestamp is not the beginning of that cue.  Allow one leading filler word
    on either side while rejecting matches that begin in the middle.
    """
    left_tokens = normalize_dialogue(left).split()
    right_tokens = normalize_dialogue(right).split()
    if not left_tokens or not right_tokens:
        return 0.0
    best = 0.0
    for left_skip in range(min(2, len(left_tokens))):
        for right_skip in range(min(2, len(right_tokens))):
            size = min(7, len(left_tokens) - left_skip, len(right_tokens) - right_skip)
            if size <= 0:
                continue
            left_prefix = " ".join(left_tokens[left_skip : left_skip + size])
            right_prefix = " ".join(right_tokens[right_skip : right_skip + size])
            best = max(best, SequenceMatcher(None, left_prefix, right_prefix, autojunk=False).ratio())
    return best


def timelines_compatible(target: list[Cue], reference: list[Cue]) -> bool:
    if not target or not reference:
        return False
    if abs(target[-1].end_ms - reference[-1].end_ms) > max(30_000, int(reference[-1].end_ms * 0.012)):
        return False
    starts = [cue.start_ms for cue in reference]
    distances: list[int] = []
    for index in range(0, len(target), max(1, len(target) // 30)):
        start = target[index].start_ms
        nearest = min(starts, key=lambda value: abs(value - start))
        distances.append(abs(nearest - start))
    return bool(distances) and median(distances) <= 2_500


def release_signature(value: str) -> tuple[str, ...]:
    aliases = {
        "nf": "netflix",
        "nflx": "netflix",
        "atvp": "apple",
        "itunes": "apple",
        "amzn": "amazon",
        "dsnp": "disney",
        "hmax": "max",
    }
    ignored = {
        "ass",
        "cc",
        "chs",
        "cht",
        "cmnhans",
        "cmnhant",
        "en",
        "eng",
        "english",
        "forced",
        "hi",
        "srt",
        "sub",
        "subtitle",
        "vtt",
        "zh",
        "zho",
    }
    tokens = [aliases.get(token, token) for token in re.findall(r"[a-z0-9]+", value.casefold())]
    return tuple(token for token in tokens if token not in ignored)


def releases_compatible(left: str, right: str) -> bool:
    """Conservatively decide whether two language files share one release."""
    left_tokens, right_tokens = release_signature(left), release_signature(right)
    if len(left_tokens) >= 2 and left_tokens == right_tokens:
        return True
    platforms = {"apple", "netflix", "amazon", "disney", "max", "hulu", "bluray"}
    left_platforms = set(left_tokens) & platforms
    right_platforms = set(right_tokens) & platforms
    if not left_platforms or left_platforms != right_platforms:
        return False
    left_set, right_set = set(left_tokens), set(right_tokens)
    overlap = len(left_set & right_set) / max(1, len(left_set | right_set))
    return overlap >= 0.72


def subtitle_candidate_label(item: dict[str, Any]) -> str:
    values = [
        str(item.get("release_name") or ""),
        str(item.get("name") or ""),
        " ".join(str(value) for value in item.get("releases") or []),
    ]
    for part in item.get("unpack_files") or []:
        if isinstance(part, dict):
            values.extend((str(part.get("release_name") or ""), str(part.get("name") or "")))
    return re.sub(r"\s+", " ", " ".join(value for value in values if value)).strip()


def is_netflix_release(value: str | dict[str, Any]) -> bool:
    label = subtitle_candidate_label(value) if isinstance(value, dict) else value
    normalized = label.casefold()
    tokens = set(re.findall(r"[a-z0-9]+", normalized))
    return "netflix" in tokens or "nflx" in tokens or "nf" in tokens and bool(tokens & {"web", "webrip", "webdl"})


def release_frame_rate(value: str) -> float | None:
    normalized = value.casefold().replace("_", ".")
    patterns = (
        (r"(?<!\d)23[.]?976(?:\s*fps)?(?!\d)", 23.976),
        (r"(?<!\d)24(?:[.]000)?\s*fps(?!\d)", 24.0),
        (r"(?<!\d)25(?:[.]000)?\s*fps(?!\d)|\bpal\b", 25.0),
        (r"(?<!\d)29[.]?97(?:0)?(?:\s*fps)?(?!\d)", 29.97),
    )
    for pattern, frame_rate in patterns:
        if re.search(pattern, normalized):
            return frame_rate
    return None


def release_family(item: dict[str, Any]) -> str:
    """Collapse duplicate SDH/non-SDH uploads from one encode family."""
    label = str(item.get("release_name") or subtitle_candidate_label(item)).casefold()
    tokens = re.findall(r"[a-z0-9]+", label)
    ignored = {
        "1080p", "2160p", "720p", "aac", "ac3", "dts", "eng", "english", "h264", "h265",
        "hevc", "hi", "sdh", "subdl", "x264", "x265",
    }
    return ".".join(token for token in tokens if token not in ignored)


def subtitle_timeline_score(cues: list[Cue], media: MediaRequest) -> int:
    if not cues or media.duration <= 0:
        return -10_000
    end_ratio = cues[-1].end_ms / (media.duration * 1000)
    if end_ratio < 0.60 or end_ratio > 1.04:
        return -10_000
    # Feature subtitles usually stop shortly before the end of the credit roll.
    return round(1000 - abs(end_ratio - 0.96) * 2000)


def alignment_offset_at(alignment: Alignment, media_time_ms: float) -> float:
    if alignment.mode != "piecewise" or not alignment.anchors:
        return (alignment.scale - 1.0) * media_time_ms + alignment.offset_ms
    anchors = alignment.anchors
    if media_time_ms <= anchors[0][0]:
        return anchors[0][1]
    if media_time_ms >= anchors[-1][0]:
        return anchors[-1][1]
    for index in range(1, len(anchors)):
        left, right = anchors[index - 1], anchors[index]
        if media_time_ms <= right[0]:
            ratio = (media_time_ms - left[0]) / max(1.0, right[0] - left[0])
            return left[1] + ratio * (right[1] - left[1])
    return anchors[-1][1]


def snap_target_starts(target: list[Cue], reference: list[Cue], maximum_shift_ms: int = 800) -> int:
    """Remove small per-cue timing differences between matching release files."""
    starts = [cue.start_ms for cue in reference]
    snapped = 0
    last_reference_index = -1
    for cue in target:
        position = bisect_left(starts, cue.start_ms)
        indexes = [index for index in (position - 1, position) if 0 <= index < len(starts) and index > last_reference_index]
        if not indexes:
            continue
        index = min(indexes, key=lambda value: abs(starts[value] - cue.start_ms))
        if abs(starts[index] - cue.start_ms) <= maximum_shift_ms:
            changed = starts[index] != cue.start_ms
            cue.start_ms = min(starts[index], cue.end_ms - 1)
            last_reference_index = index
            snapped += int(changed)
    return snapped


def alignment_matches(
    captions: list[CaptionSample],
    reference: list[Cue],
) -> list[tuple[float, float, float, bool]]:
    """Match Apple CC cues to English cues without assuming one subtitle author."""
    captions = sorted(captions, key=lambda item: item.start_ms)
    matches: list[tuple[float, float, float, bool]] = []
    used_cues: set[int] = set()
    for caption_index, caption in enumerate(captions):
        best: tuple[float, int, int] | None = None
        second_score = 0.0
        expected_local = caption.start_ms - APPLE_MEDIA_TIME_OFFSET_MS
        for index, cue in enumerate(reference):
            if abs(cue.start_ms - expected_local) > 20_000:
                continue
            variants = [(cue.text, cue.start_ms)]
            if index + 1 < len(reference) and reference[index + 1].start_ms - cue.end_ms < 5_000:
                variants.append((f"{cue.text} {reference[index + 1].text}", cue.start_ms))
            score, start = max(
                (
                    dialogue_similarity(caption.text, text)
                    if dialogue_prefix_similarity(caption.text, text) >= 0.72
                    else 0.0,
                    start,
                )
                for text, start in variants
            )
            if best is None or score > best[0]:
                second_score = best[0] if best else second_score
                best = score, index, start
            elif score > second_score:
                second_score = score
        if not best:
            continue
        score, cue_index, cue_start = best
        required = 0.82 if len(normalize_dialogue(caption.text)) < 12 else 0.72
        if score < required or score - second_score < 0.04 or cue_index in used_cues:
            continue
        used_cues.add(cue_index)
        previous = captions[caption_index - 1] if caption_index else None
        previous_end = previous.end_ms if previous and previous.end_ms is not None else previous.start_ms if previous else 0
        paragraph_start = previous is None or caption.start_ms - previous_end >= PARAGRAPH_GAP_MS
        matches.append((cue_start + APPLE_MEDIA_TIME_OFFSET_MS, caption.start_ms, score, paragraph_start))
    return matches


def estimate_alignment(captions: list[CaptionSample], reference: list[Cue]) -> Alignment | None:
    """Fit one guarded offset/clock transform and validate it on every text match."""
    all_matches = alignment_matches(captions, reference)
    matches = all_matches

    paragraph_matches = [item for item in matches if item[3]]
    if len(paragraph_matches) >= 5 and max(item[0] for item in paragraph_matches) - min(item[0] for item in paragraph_matches) >= 120_000:
        matches = paragraph_matches
    if len(matches) < 5:
        return None
    raw_offsets = [target - source for source, target, _, _ in matches]
    center = median(raw_offsets)
    deviations = [abs(value - center) for value in raw_offsets]
    mad = median(deviations)
    tolerance = max(1_200.0, 3.5 * mad)
    filtered = [item for item in matches if abs((item[1] - item[0]) - center) <= tolerance]
    if len(filtered) < 5:
        return None
    span = max(item[0] for item in filtered) - min(item[0] for item in filtered)
    if span < 120_000:
        return None

    constant_offset = median([target - source for source, target, _, _ in filtered])
    constant_residual = median([abs(target - (source + constant_offset)) for source, target, _, _ in filtered])
    scale, offset, mode, residual = 1.0, float(constant_offset), "offset", float(constant_residual)
    anchors: tuple[tuple[int, float], ...] = ()

    slopes = [
        (right[1] - left[1]) / (right[0] - left[0])
        for index, left in enumerate(filtered)
        for right in filtered[index + 1 :]
        if right[0] - left[0] >= 300_000
    ]
    if mode == "offset" and len(filtered) >= 6 and span >= 1_200_000 and slopes:
        candidate_scale = median(slopes)
        if 0.95 <= candidate_scale <= 1.05:
            candidate_offset = median([target - candidate_scale * source for source, target, _, _ in filtered])
            candidate_residual = median([abs(target - (candidate_scale * source + candidate_offset)) for source, target, _, _ in filtered])
            endpoint_drift = abs(candidate_scale - 1.0) * span
            if abs(candidate_scale - 1.0) >= 0.00015 and endpoint_drift >= 1_000 and candidate_residual <= constant_residual * 0.65:
                scale, offset, mode, residual = float(candidate_scale), float(candidate_offset), "affine", float(candidate_residual)

    validation_residuals = sorted(
        abs(target - (scale * source + offset))
        for source, target, _, _ in all_matches
    )
    if not validation_residuals:
        return None
    validation_median = float(median(validation_residuals))
    p80_index = min(len(validation_residuals) - 1, max(0, int(len(validation_residuals) * 0.8)))
    validation_p80 = float(validation_residuals[p80_index])
    evidence_coverage = int(max(item[0] for item in all_matches) - min(item[0] for item in all_matches))
    if (
        abs(offset) > 20_000
        or any(abs(item[1]) > 20_000 for item in anchors)
        or validation_median > 1_200
        or validation_p80 > 2_500
    ):
        return None
    confidence = min(1.0, len(filtered) / 8) * max(0.0, 1.0 - residual / 2_000)
    if confidence < 0.45:
        return None
    return Alignment(
        scale,
        offset,
        len(filtered),
        validation_median,
        confidence,
        mode,
        anchors,
        validation_p80,
        evidence_coverage,
        len(all_matches),
    )


def apply_alignment(cues: list[Cue], alignment: Alignment) -> None:
    for cue in cues:
        start_media = cue.start_ms + APPLE_MEDIA_TIME_OFFSET_MS
        end_media = cue.end_ms + APPLE_MEDIA_TIME_OFFSET_MS
        cue.start_ms = max(
            0,
            round(
                start_media
                + alignment_offset_at(alignment, start_media)
                - APPLE_MEDIA_TIME_OFFSET_MS
            ),
        )
        cue.end_ms = max(
            cue.start_ms + 1,
            round(
                end_media
                + alignment_offset_at(alignment, end_media)
                - APPLE_MEDIA_TIME_OFFSET_MS
            ),
        )


def undo_legacy_alignment(cues: list[Cue], value: dict[str, Any]) -> None:
    """Restore v1 offset/affine caches before recalibrating with a newer model."""
    if value.get("version") != 1 or value.get("status") != "applied":
        return
    try:
        scale = float(value.get("scale") or 1.0)
        offset = float(value.get("offset_ms") or 0.0)
    except (TypeError, ValueError):
        return
    if not 0.9 <= scale <= 1.1:
        return
    for cue in cues:
        start_media = (cue.start_ms + APPLE_MEDIA_TIME_OFFSET_MS - offset) / scale
        end_media = (cue.end_ms + APPLE_MEDIA_TIME_OFFSET_MS - offset) / scale
        cue.start_ms = max(0, round(start_media - APPLE_MEDIA_TIME_OFFSET_MS))
        cue.end_ms = max(cue.start_ms + 1, round(end_media - APPLE_MEDIA_TIME_OFFSET_MS))


def request_bytes(url: str, timeout: int, headers: dict[str, str] | None = None, data: bytes | None = None) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read(), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        detail = error.read(500).decode("utf-8", errors="replace")
        raise GatewayError(f"upstream HTTP {error.code}: {detail}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise GatewayError(f"upstream request failed: {error}") from error


def request_json(url: str, timeout: int, headers: dict[str, str] | None = None, payload: Any | None = None) -> Any:
    body = None
    merged_headers = {"Accept": "application/json", "User-Agent": f"AppleSubtitleGateway/{APP_VERSION}"}
    if headers:
        merged_headers.update(headers)
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        merged_headers["Content-Type"] = "application/json"
    data, _ = request_bytes(url, timeout, merged_headers, body)
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GatewayError("upstream returned invalid JSON") from error


class SubtitleGateway:
    def __init__(self, config: Config):
        self.config = config
        self.config.cache_dir.mkdir(parents=True, exist_ok=True)

    def cache_path(self, media: MediaRequest) -> Path:
        return self.config.cache_dir / media.asset_id / "subtitle.vtt"

    def metadata_path(self, media: MediaRequest) -> Path:
        return self.config.cache_dir / media.asset_id / "metadata.json"

    def read_metadata(self, media: MediaRequest) -> dict[str, Any]:
        path = self.metadata_path(media)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def reference_path(self, asset_id: str) -> Path:
        return self.config.cache_dir / asset_id / "apple-reference.json"

    def register_reference(self, asset_id: str, value: str) -> None:
        if not re.fullmatch(r"\d{4,20}", asset_id):
            raise GatewayError("invalid asset id", HTTPStatus.BAD_REQUEST)
        url = canonicalize_apple_url(value)
        target = self.reference_path(asset_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(".tmp")
        temp.write_text(json.dumps({"url": url, "registered_at": int(time.time())}), encoding="utf-8")
        os.replace(temp, target)

    def read_reference(self, media: MediaRequest) -> str:
        path = self.reference_path(media.asset_id)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if time.time() - float(value.get("registered_at") or 0) > 21_600:
                return ""
            return canonicalize_apple_url(str(value.get("url") or ""))
        except (OSError, ValueError, TypeError, json.JSONDecodeError, GatewayError):
            return ""

    def fetch_apple_captions(self, media: MediaRequest) -> list[CaptionSample]:
        playlist_url = self.read_reference(media)
        if not playlist_url:
            return []
        headers = {"User-Agent": "AppleCoreMedia/1.0"}
        data, _ = request_bytes(playlist_url, min(self.config.timeout_seconds, 30), headers)
        if len(data) > 2_000_000:
            raise GatewayError("Apple media playlist is unexpectedly large")
        lines = data.decode("utf-8", errors="replace").splitlines()
        marker = f"A{media.asset_id}"
        segments = [
            canonicalize_apple_url(urllib.parse.urljoin(playlist_url, line.strip()))
            for line in lines
            if line.strip() and not line.startswith("#") and marker in line and ".m4s" in line
        ]
        if not segments:
            LOG.info("alignment skipped asset=%s reason=no-main-segments", media.asset_id)
            return []

        # Sample pairs of adjacent fragments at distributed points. This stays
        # small while avoiding silent scenes that carry no caption samples.
        anchors = [0.025, 0.05, 0.08, 0.12, 0.18, 0.27, 0.38, 0.50, 0.63, 0.76, 0.87, 0.94]
        indexes = sorted({min(len(segments) - 1, max(0, round((len(segments) - 1) * point) + delta)) for point in anchors for delta in (0, 1)})

        def fetch_fragment(index: int) -> list[CaptionSample]:
            fragment, _ = request_bytes(segments[index], min(self.config.timeout_seconds, 25), headers)
            if len(fragment) > 2_500_000:
                return []
            try:
                return fragment_caption_samples(fragment)
            except (IndexError, struct.error, ValueError):
                return []

        captions: list[CaptionSample] = []
        with ThreadPoolExecutor(max_workers=6, thread_name_prefix="apple-cc") as executor:
            futures = [executor.submit(fetch_fragment, index) for index in indexes]
            for future in as_completed(futures):
                try:
                    captions.extend(future.result())
                except GatewayError as error:
                    LOG.debug("Apple CC sample failed asset=%s error=%s", media.asset_id, error)
        unique: dict[tuple[int, str], CaptionSample] = {}
        for sample in captions:
            normalized = normalize_dialogue(sample.text)
            if normalized:
                unique[(sample.start_ms, normalized)] = sample
        output = sorted(unique.values(), key=lambda sample: sample.start_ms)
        LOG.info("Apple CC sampled asset=%s fragments=%s captions=%s", media.asset_id, len(indexes), len(output))
        return output

    def english_candidate_score(
        self,
        item: dict[str, Any],
        media: MediaRequest,
        preferred_release: str = "",
    ) -> tuple[int, int, int, int, int, int, int, int, int, int]:
        label = subtitle_candidate_label(item)
        normalized = label.casefold()
        source_frame_rate = release_frame_rate(label)
        if media.frame_rate and source_frame_rate:
            frame_rate_match = int(abs(media.frame_rate - source_frame_rate) <= 0.03) * 2
        else:
            frame_rate_match = 1
        retail = int(any(marker in normalized for marker in ("retail", "remux", "framestor")))
        studio_source = int(any(marker in normalized for marker in ("bluray", "blu-ray", "web-dl", "webdl")))
        single_file = int(not re.search(r"\bcd\s*[12]\b|\bcd[12]\b", normalized))
        supported, simplified, not_traditional, overlap, apple, _, web, not_hi, unpacked = self.candidate_score(item, preferred_release)
        return (
            supported,
            int(not is_netflix_release(label)),
            apple,
            frame_rate_match,
            overlap,
            retail,
            studio_source,
            single_file,
            not_hi,
            unpacked + web + simplified + not_traditional,
        )

    def select_english_reference(
        self,
        media: MediaRequest,
        identity: dict[str, Any],
        preferred_release: str,
    ) -> tuple[list[Cue], str, Alignment | None, dict[str, Any]]:
        """Evaluate a few non-Netflix releases against Apple before translating."""
        english = self.search_subdl(media, "en", identity, preferred_release)
        english = [item for item in english if not is_netflix_release(item)]
        if not english:
            raise GatewayError("no usable non-Netflix English subtitle found", HTTPStatus.NOT_FOUND)
        english.sort(key=lambda item: self.english_candidate_score(item, media, preferred_release), reverse=True)
        buckets: dict[str, list[dict[str, Any]]] = {key: [] for key in ("apple", "web", "disc", "other", "dvd")}
        for item in english:
            label = subtitle_candidate_label(item).casefold()
            if any(marker in label for marker in ("atvp", "itunes", "apple tv", "apple-tv")):
                bucket = "apple"
            elif any(marker in label for marker in ("web-dl", "webdl", "webrip", " web ", ".web.")):
                bucket = "web"
            elif any(marker in label for marker in ("bluray", "blu-ray", "brrip", "remux")):
                bucket = "disc"
            elif any(marker in label for marker in ("dvdrip", "dvd-r", " dvd ", ".dvd.")):
                bucket = "dvd"
            else:
                bucket = "other"
            buckets[bucket].append(item)
        diversified: list[dict[str, Any]] = []
        while any(buckets.values()):
            for bucket in ("apple", "web", "disc", "other", "dvd"):
                if buckets[bucket]:
                    diversified.append(buckets[bucket].pop(0))
        english = diversified

        try:
            captions = self.fetch_apple_captions(media)
        except GatewayError as error:
            LOG.info("Apple CC candidate evaluation unavailable asset=%s error=%s", media.asset_id, error)
            captions = []

        evaluated: list[tuple[tuple[Any, ...], list[Cue], str, Alignment | None, dict[str, Any]]] = []
        successful_families: set[str] = set()
        attempts = 0
        successes = 0
        for item in english:
            if attempts >= 12 or successes >= 4:
                break
            family = release_family(item)
            if family and family in successful_families:
                continue
            attempts += 1
            try:
                data, name, label = self.download_candidate_cached(media, item)
                cues = parse_subtitle(data, name)
            except GatewayError as error:
                LOG.info("English candidate unavailable asset=%s release=%r error=%s", media.asset_id, subtitle_candidate_label(item)[:120], error)
                continue
            timeline_score = subtitle_timeline_score(cues, media)
            if timeline_score <= -10_000:
                LOG.info("English candidate rejected asset=%s release=%r reason=duration", media.asset_id, label)
                continue
            successes += 1
            if family:
                successful_families.add(family)
            alignment = estimate_alignment(captions, cues) if captions else None
            source_frame_rate = release_frame_rate(label)
            if alignment:
                coverage_ratio = min(1.0, alignment.coverage_ms / max(1.0, media.duration * 1000))
                quality: tuple[Any, ...] = (
                    1,
                    round(coverage_ratio * 1000),
                    -round(alignment.p80_residual_ms),
                    -round(alignment.residual_ms),
                    alignment.evidence_matches,
                    timeline_score,
                )
            else:
                quality = (0, timeline_score, self.english_candidate_score(item, media, preferred_release))
            details = {
                "release": label,
                "source_frame_rate": source_frame_rate,
                "apple_frame_rate": media.frame_rate,
                "timeline_score": timeline_score,
                "cues": len(cues),
                "alignment_matches": alignment.evidence_matches if alignment else 0,
                "alignment_coverage_ms": alignment.coverage_ms if alignment else 0,
                "alignment_residual_ms": round(alignment.residual_ms) if alignment else None,
                "alignment_p80_ms": round(alignment.p80_residual_ms) if alignment else None,
            }
            evaluated.append((quality, cues, label, alignment, details))
        if not evaluated:
            raise GatewayError("no downloadable non-Netflix English subtitle passed duration checks", HTTPStatus.NOT_FOUND)
        evaluated.sort(key=lambda item: item[0], reverse=True)
        _, cues, label, alignment, details = evaluated[0]
        details["evaluated_candidates"] = len(evaluated)
        details["apple_cc_samples"] = len(captions)
        LOG.info("English candidate selected asset=%s details=%s", media.asset_id, details)
        return cues, label, alignment, details

    def english_alignment_reference(
        self,
        media: MediaRequest,
        identity: dict[str, Any],
        preferred_release: str,
    ) -> list[Cue]:
        try:
            reference, _, _, _ = self.select_english_reference(media, identity, preferred_release)
            return reference
        except GatewayError as error:
            LOG.info("alignment English reference unavailable asset=%s error=%s", media.asset_id, error)
            return []

    def align_cues(
        self,
        media: MediaRequest,
        cues: list[Cue],
        reference: list[Cue],
        precomputed: Alignment | None = None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {"version": ALIGNMENT_VERSION, "status": "skipped"}
        if not reference or precomputed is None and not self.read_reference(media):
            result["reason"] = "reference-unavailable"
            return result
        if cues is not reference and not timelines_compatible(cues, reference):
            result["reason"] = "subtitle-timelines-differ"
            return result
        alignment = precomputed
        if alignment is None:
            try:
                captions = self.fetch_apple_captions(media)
                alignment = estimate_alignment(captions, reference)
            except GatewayError as error:
                LOG.info("alignment skipped asset=%s error=%s", media.asset_id, error)
                result["reason"] = "apple-reference-fetch-failed"
                return result
        if alignment is None:
            result["reason"] = "low-confidence"
            return result
        snapped = snap_target_starts(cues, reference)
        apply_alignment(cues, alignment)
        result.update(
            {
                "status": "applied",
                "mode": alignment.mode,
                "scale": round(alignment.scale, 9),
                "offset_ms": round(alignment.offset_ms),
                "matches": alignment.matches,
                "evidence_matches": alignment.evidence_matches,
                "coverage_ms": alignment.coverage_ms,
                "residual_ms": round(alignment.residual_ms),
                "p80_residual_ms": round(alignment.p80_residual_ms),
                "confidence": round(alignment.confidence, 3),
                "timing_snaps": snapped,
                "anchors": [[time_ms, round(offset_ms)] for time_ms, offset_ms in alignment.anchors],
            }
        )
        LOG.info("alignment applied asset=%s result=%s", media.asset_id, result)
        return result

    @staticmethod
    def prepare_vtt(vtt: str) -> str:
        return ensure_vtt_timestamp_map(vtt)

    def playlist(self, media: MediaRequest, query_string: str) -> str:
        duration = max(30, min(86400, int(media.duration + 1)))
        version_query = urllib.parse.urlencode({"gateway_version": APP_VERSION})
        quoted_query = f"?{query_string}&{version_query}" if query_string else f"?{version_query}"
        return "\n".join(
            [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                f"#EXT-X-TARGETDURATION:{duration}",
                f"#EXT-X-DISCONTINUITY-SEQUENCE:{media.discontinuity_sequence}",
                "#EXT-X-MEDIA-SEQUENCE:0",
                f"#EXTINF:{duration}.000,",
                f"subtitle.vtt{quoted_query}",
                "#EXT-X-ENDLIST",
                "",
            ]
        )

    def get_vtt(self, media: MediaRequest) -> tuple[str, str]:
        target = self.cache_path(media)
        if target.exists() and target.stat().st_size > 20 and not self.should_align_cached(media):
            os.utime(target, None)
            return self.prepare_vtt(target.read_text(encoding="utf-8")), "cache"

        target.parent.mkdir(parents=True, exist_ok=True)
        lock_path = target.parent / ".lock"
        with lock_path.open("a+b") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            if target.exists() and target.stat().st_size > 20:
                if self.should_align_cached(media):
                    self.maybe_align_cached(media, target)
                os.utime(target, None)
                return self.prepare_vtt(target.read_text(encoding="utf-8")), "cache-wait"

            previous_metadata = self.read_metadata(media)
            cues, source, alignment_reference, precomputed_alignment, selection = self.resolve(
                media,
                str(previous_metadata.get("source") or ""),
            )
            original = target.parent / "unaligned.vtt"
            original_temp = original.with_suffix(".tmp")
            original_temp.write_text(render_vtt(cues), encoding="utf-8")
            os.replace(original_temp, original)
            alignment = self.align_cues(media, cues, alignment_reference, precomputed_alignment)
            rendered = render_vtt(cues)
            temp = target.with_suffix(".tmp")
            temp.write_text(rendered, encoding="utf-8")
            os.replace(temp, target)
            metadata = {
                "asset_id": media.asset_id,
                "title": media.title,
                "year": media.year,
                "type": media.media_type,
                "season": media.season,
                "episode": media.episode,
                "source": source,
                "resolver": "subdl-v5-apple-evaluated-non-netflix",
                "selection": selection,
                "cues": len(cues),
                "created_at": int(time.time()),
                "alignment": {**alignment, "attempted_at": int(time.time())},
            }
            self.metadata_path(media).write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self.prune_cache()
            return self.prepare_vtt(rendered), source

    def should_align_cached(self, media: MediaRequest) -> bool:
        metadata = self.read_metadata(media)
        # Existing working subtitles remain immutable across resolver upgrades.
        # A title is deliberately rebuilt by removing only that asset's cache.
        if metadata.get("resolver") != "subdl-v5-apple-evaluated-non-netflix":
            return False
        alignment = metadata.get("alignment") if isinstance(metadata.get("alignment"), dict) else {}
        if alignment.get("version") == ALIGNMENT_VERSION:
            if alignment.get("status") == "applied":
                return False
            if time.time() - float(alignment.get("attempted_at") or 0) < 21_600:
                return False
        return bool(self.read_reference(media))

    def maybe_align_cached(self, media: MediaRequest, target: Path) -> None:
        metadata = self.read_metadata(media)
        try:
            original = target.parent / "unaligned.vtt"
            cues = parse_subtitle((original if original.exists() else target).read_bytes(), "subtitle.vtt")
            if not original.exists():
                previous_alignment = metadata.get("alignment") if isinstance(metadata.get("alignment"), dict) else {}
                undo_legacy_alignment(cues, previous_alignment)
            identity = self.resolve_subdl_title(media)
            reference = self.english_alignment_reference(media, identity, str(metadata.get("source") or ""))
            result = self.align_cues(media, cues, reference)
            if not original.exists():
                original_temp = original.with_suffix(".tmp")
                original_temp.write_text(render_vtt(cues if result.get("status") != "applied" else parse_subtitle(target.read_bytes(), "subtitle.vtt")), encoding="utf-8")
                if result.get("status") == "applied":
                    raw_cues = parse_subtitle(target.read_bytes(), "subtitle.vtt")
                    undo_legacy_alignment(raw_cues, previous_alignment)
                    original_temp.write_text(render_vtt(raw_cues), encoding="utf-8")
                os.replace(original_temp, original)
            if result.get("status") == "applied":
                temp = target.with_suffix(".tmp")
                temp.write_text(render_vtt(cues), encoding="utf-8")
                os.replace(temp, target)
            metadata["alignment"] = {**result, "attempted_at": int(time.time())}
            meta_target = self.metadata_path(media)
            meta_temp = meta_target.with_suffix(".tmp")
            meta_temp.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(meta_temp, meta_target)
        except (GatewayError, OSError, ValueError) as error:
            LOG.info("cached alignment skipped asset=%s error=%s", media.asset_id, error)

    def resolve(
        self,
        media: MediaRequest,
        preferred_release: str = "",
    ) -> tuple[list[Cue], str, list[Cue], Alignment | None, dict[str, Any]]:
        if not self.config.subdl_api_key:
            raise GatewayError("SubDL API key is not configured", HTTPStatus.SERVICE_UNAVAILABLE)

        identity = self.resolve_subdl_title(media)
        reference, english_label, precomputed_alignment, selection = self.select_english_reference(
            media,
            identity,
            preferred_release,
        )

        # Human Chinese is preferred only when both the release label and the
        # actual cue timelines agree with the selected English file. Otherwise
        # translating that English file is safer: text and timing then come
        # from exactly one source release.
        for language in self.config.chinese_languages:
            candidates = self.search_subdl(media, language, identity, english_label)
            for candidate in candidates[:2]:
                try:
                    data, name, label = self.download_candidate_cached(media, candidate)
                except GatewayError as error:
                    LOG.info("Chinese candidate unavailable asset=%s error=%s", media.asset_id, error)
                    continue
                if not releases_compatible(label, english_label):
                    continue
                cues = parse_subtitle(data, name)
                if timelines_compatible(cues, reference):
                    return cues, f"subdl:{language}:{label}", reference, precomputed_alignment, selection

        if not self.config.gemini_api_key:
            raise GatewayError("same-release Chinese subtitle missing and Gemini key is not configured", HTTPStatus.NOT_FOUND)
        cues = [Cue(cue.start_ms, cue.end_ms, cue.text, cue.settings) for cue in reference]
        reference = [Cue(cue.start_ms, cue.end_ms, cue.text, cue.settings) for cue in cues]
        self.translate_cues(cues)
        return cues, f"subdl:EN+gemini:{english_label}", reference, precomputed_alignment, selection

    def subdl_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.subdl_api_key}"}

    def resolve_subdl_title(self, media: MediaRequest) -> dict[str, Any]:
        params = {"q": media.title, "type": media.media_type, "limit": "10"}
        url = "https://api.subdl.com/api/v2/movies/search?" + urllib.parse.urlencode(params)
        result = request_json(url, self.config.timeout_seconds, self.subdl_headers())
        candidates = result.get("results") if isinstance(result, dict) else None
        if not isinstance(candidates, list):
            raise GatewayError("SubDL title search returned an invalid response")

        title_key = normalize_title(media.title)
        exact: list[dict[str, Any]] = []
        for item in candidates:
            if not isinstance(item, dict):
                continue
            names = (str(item.get("name") or ""), str(item.get("original_name") or ""))
            if title_key not in {normalize_title(name) for name in names if name}:
                continue
            result_year = parse_int(str(item.get("year") or ""), 1880, 2200)
            if media.year and result_year and abs(media.year - result_year) > 1:
                continue
            exact.append(item)
        if not exact:
            raise GatewayError("no exact SubDL title/year match found", HTTPStatus.NOT_FOUND)
        exact.sort(key=lambda item: int(bool(item.get("imdb_id"))), reverse=True)
        return exact[0]

    def search_subdl(
        self,
        media: MediaRequest,
        language: str,
        identity: dict[str, Any],
        preferred_release: str = "",
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {
            "languages": language.lower(),
            "subs_per_page": "30",
            "unpack": "1",
        }
        if identity.get("imdb_id"):
            params["imdb_id"] = str(identity["imdb_id"])
        elif identity.get("sd_id"):
            params["sd_id"] = str(identity["sd_id"])
        elif identity.get("tmdb_id"):
            params["tmdb_id"] = str(identity["tmdb_id"])
            params["type"] = media.media_type
        else:
            raise GatewayError("SubDL title result has no stable identifier")
        if media.media_type == "tv" and media.season:
            params["season"] = str(media.season)
        if media.media_type == "tv" and media.episode:
            params["episode"] = str(media.episode)
        url = "https://api.subdl.com/api/v2/subtitles/search?" + urllib.parse.urlencode(params)
        result = request_json(url, self.config.timeout_seconds, self.subdl_headers())
        if not isinstance(result, dict) or not result.get("status"):
            LOG.warning("SubDL search failed for %s/%s: %s", media.asset_id, language, result.get("error") if isinstance(result, dict) else "invalid response")
            return []
        results = result.get("results") or []
        if results:
            first_result = results[0]
            result_title = str(first_result.get("name") or "")
            if normalize_title(result_title) != normalize_title(media.title):
                LOG.warning("SubDL title mismatch: wanted=%r got=%r", media.title, result_title)
                return []
            wanted_id = str(identity.get("imdb_id") or identity.get("sd_id") or identity.get("tmdb_id") or "")
            result_id = str(first_result.get("imdb_id") or first_result.get("sd_id") or first_result.get("tmdb_id") or "")
            if wanted_id and result_id and wanted_id != result_id:
                LOG.warning("SubDL identity mismatch: wanted=%s got=%s", wanted_id, result_id)
                return []
        subtitles = [item for item in result.get("subtitles") or [] if isinstance(item, dict)]
        subtitles.sort(key=lambda item: self.candidate_score(item, preferred_release), reverse=True)
        return subtitles

    @staticmethod
    def candidate_score(item: dict[str, Any], preferred_release: str = "") -> tuple[int, int, int, int, int, int, int, int, int]:
        release = " ".join(
            [
                str(item.get("release_name") or ""),
                str(item.get("name") or ""),
                " ".join(str(value) for value in item.get("releases") or []),
                " ".join(
                    f"{part.get('release_name', '')} {part.get('name', '')}"
                    for part in item.get("unpack_files") or []
                    if isinstance(part, dict)
                ),
            ]
        ).casefold()
        extension = Path(str(item.get("name") or "")).suffix.casefold()
        tokens = set(re.findall(r"[a-z0-9]+", release))
        preferred_tokens = set(re.findall(r"[a-z0-9]+", preferred_release.casefold()))
        ignored = {"subdl", "gemini", "english", "chinese", "movie", "subtitle", "en", "zh", "hi"}
        release_overlap = len((tokens - ignored) & (preferred_tokens - ignored)) if preferred_tokens else 0
        simplified = int(any(marker in release for marker in ("cmnhans", "chs", "zh-cn", "zh_cn", "简体")))
        traditional = int(any(marker in release for marker in ("cmnhant", "cht", "yue", "zh-tw", "zh_tw", "繁体", "繁體")))
        apple = int(any(marker in release for marker in ("atvp", "itunes", "apple tv", "apple-tv")))
        web = int(any(marker in release for marker in ("web-dl", "webdl", "webrip", "amzn", "atvp")))
        not_netflix = int(not any(marker in release for marker in ("netflix", "nf web", "nfweb")))
        supported = int(extension in {".srt", ".ass", ".ssa", ".vtt", ".zip"} or bool(item.get("unpack_files")))
        not_hi = int(not bool(item.get("hi")))
        unpacked = int(bool(item.get("unpack_files")))
        return supported, simplified, 1 - traditional, release_overlap, apple, not_netflix, web, not_hi, unpacked

    def download_candidate_cached(self, media: MediaRequest, item: dict[str, Any]) -> tuple[bytes, str, str]:
        """Cache parsed provider files so candidate evaluation never spends twice."""
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "url": item.get("url"),
                    "name": item.get("name"),
                    "release_name": item.get("release_name"),
                    "unpack_files": item.get("unpack_files"),
                },
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()[:24]
        directory = self.config.cache_dir / media.asset_id / "candidates"
        data_path = directory / f"{cache_key}.subtitle"
        metadata_path = directory / f"{cache_key}.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            data = data_path.read_bytes()
            if data and isinstance(metadata, dict):
                return data, str(metadata.get("name") or "subtitle.srt"), str(metadata.get("label") or "subtitle")
        except (OSError, json.JSONDecodeError):
            pass

        data, name, label = self.download_candidate(item)
        if len(data) <= 5_000_000:
            directory.mkdir(parents=True, exist_ok=True)
            # Keep the two atomic-write staging files distinct. Using
            # with_suffix(".tmp") for both paths collapses
            # <key>.subtitle and <key>.json into the same <key>.tmp file.
            data_temp = data_path.with_name(f"{data_path.name}.tmp")
            metadata_temp = metadata_path.with_name(f"{metadata_path.name}.tmp")
            data_temp.write_bytes(data)
            metadata_temp.write_text(
                json.dumps({"name": name, "label": label}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(data_temp, data_path)
            os.replace(metadata_temp, metadata_path)
        return data, name, label

    def download_candidate(self, item: dict[str, Any]) -> tuple[bytes, str, str]:
        unpacked = [part for part in item.get("unpack_files") or [] if isinstance(part, dict)]
        unpacked = [part for part in unpacked if Path(str(part.get("name") or "")).suffix.casefold() in {".srt", ".ass", ".ssa", ".vtt"}]
        if unpacked:
            unpacked.sort(key=self.unpacked_part_score, reverse=True)
            part = unpacked[0]
            path = str(part.get("url") or "")
            if not path:
                raise GatewayError("SubDL unpacked subtitle has no URL")
            data, _ = request_bytes(
                authenticated_subdl_url(path),
                self.config.timeout_seconds,
                {"User-Agent": f"AppleSubtitleGateway/{APP_VERSION}", **self.subdl_headers()},
            )
            name = str(part.get("name") or "subtitle.srt")
            return data, name, str(part.get("release_name") or name)

        path = str(item.get("url") or "")
        if not path:
            raise GatewayError("SubDL subtitle has no download URL")
        data, headers = request_bytes(
            authenticated_subdl_url(path),
            self.config.timeout_seconds,
            {"User-Agent": f"AppleSubtitleGateway/{APP_VERSION}", **self.subdl_headers()},
        )
        name = str(item.get("name") or "subtitle.zip")
        content_type = headers.get("Content-Type", "").casefold()
        if data.startswith(b"PK\x03\x04") or name.casefold().endswith(".zip") or "zip" in content_type:
            data, name = extract_best_from_zip(data)
        return data, name, str(item.get("release_name") or name)

    @staticmethod
    def unpacked_part_score(part: dict[str, Any]) -> tuple[int, int, int, int, int]:
        label = f"{part.get('release_name', '')} {part.get('name', '')}".casefold()
        extension = Path(str(part.get("name") or "")).suffix.casefold()
        simplified = int(any(marker in label for marker in ("cmnhans", "chs", "zh-cn", "zh_cn", "简体")))
        traditional = int(any(marker in label for marker in ("cmnhant", "cht", "yue", "zh-tw", "zh_tw", "繁体", "繁體")))
        supported = int(extension in {".srt", ".ass", ".ssa", ".vtt"})
        not_hi = int(not bool(part.get("hi")))
        return supported, simplified, 1 - traditional, not_hi, int(part.get("size") or 0)

    def translate_cues(self, cues: list[Cue]) -> None:
        size = self.config.gemini_batch_size
        batches = [(start, cues[start : start + size]) for start in range(0, len(cues), size)]
        workers = min(getattr(self.config, "gemini_concurrency", 3), len(batches))
        completed: dict[int, dict[int, str]] = {}
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="gemini") as executor:
            futures = {
                executor.submit(
                    self.translate_items_with_repair,
                    [{"id": index, "text": cue.text} for index, cue in enumerate(batch)],
                ): (start, len(batch))
                for start, batch in batches
            }
            for future in as_completed(futures):
                start, _ = futures[future]
                completed[start] = future.result()

        # Commit to cues only after every batch succeeds, so a partial movie is
        # never cached if one concurrent request fails.
        for start, batch in batches:
            translated = completed[start]
            for index, cue in enumerate(batch):
                cue.text = translated[index]

    def translate_items_with_repair(self, items: list[dict[str, Any]]) -> dict[int, str]:
        pending = list(items)
        translated: dict[int, str] = {}
        for repair_round in range(4):
            received = self.translate_batch(pending)
            translated.update(received)
            pending = [item for item in pending if item["id"] not in translated]
            if not pending:
                break
            LOG.warning(
                "Gemini omitted %s/%s entries; repair round %s",
                len(pending),
                len(items),
                repair_round + 1,
            )
            time.sleep(1.0 + repair_round)
        if pending:
            missing = ",".join(str(item["id"]) for item in pending[:20])
            raise GatewayError(f"Gemini still omitted {len(pending)} entries after repair: {missing}")
        output: dict[int, str] = {}
        for item in items:
            item_id = int(item["id"])
            cleaned = str(translated[item_id]).strip()
            if not cleaned:
                raise GatewayError("Gemini returned an empty translation")
            output[item_id] = cleaned
        return output

    def translate_batch(self, items: list[dict[str, Any]]) -> dict[int, str]:
        model = urllib.parse.quote(self.config.gemini_model, safe="-_.")
        # Public release: keep the credential out of URLs/proxy request logs.
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        prompt = (
            "Translate every subtitle entry from English to natural Simplified Chinese. "
            "Preserve meaning, tone, names, and line breaks. Return only a JSON object in this exact shape: "
            '{"translations":[{"id":0,"text":"译文"}]}. '
            "Copy every numeric id exactly once; do not omit, merge, renumber, or reorder entries.\nINPUT:\n"
            + json.dumps(items, ensure_ascii=False)
        )
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        }
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                result = request_json(url, self.config.timeout_seconds, headers={"x-goog-api-key": self.config.gemini_api_key}, payload=payload)
                raw = result["candidates"][0]["content"]["parts"][0]["text"]
                parsed = json.loads(raw) if isinstance(raw, str) else raw
                translations = parsed.get("translations") if isinstance(parsed, dict) else None
                if not isinstance(translations, list):
                    raise GatewayError("Gemini response did not contain a translations array")
                expected = {int(item["id"]) for item in items}
                output: dict[int, str] = {}
                for item in translations:
                    if not isinstance(item, dict):
                        continue
                    try:
                        item_id = int(item.get("id"))
                    except (TypeError, ValueError):
                        continue
                    value = item.get("text")
                    if item_id in expected and isinstance(value, str) and value.strip():
                        output[item_id] = value.strip()
                if output:
                    return output
                raise GatewayError("Gemini returned no usable translation IDs")
            except (GatewayError, KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
                last_error = error
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
        raise GatewayError(f"Gemini translation failed: {last_error}")

    def prune_cache(self) -> None:
        entries = [path for path in self.config.cache_dir.iterdir() if path.is_dir() and (path / "subtitle.vtt").exists()]
        entries.sort(key=lambda path: (path / "subtitle.vtt").stat().st_mtime, reverse=True)
        for old in entries[self.config.max_cache_entries :]:
            shutil.rmtree(old, ignore_errors=True)


def absolute_subdl_url(path: str) -> str:
    if path.startswith("https://"):
        return path
    return "https://dl.subdl.com" + (path if path.startswith("/") else f"/{path}")


def authenticated_subdl_url(path: str) -> str:
    """Use the Authorization header and keep API credentials out of URLs/logs."""
    parsed = urllib.parse.urlsplit(absolute_subdl_url(path))
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(key, value) for key, value in query if key.casefold() != "api_key"]
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))


def extract_best_from_zip(data: bytes) -> tuple[bytes, str]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            candidates = [
                info
                for info in archive.infolist()
                if not info.is_dir() and Path(info.filename).suffix.casefold() in {".srt", ".ass", ".ssa", ".vtt"}
            ]
            if not candidates:
                raise GatewayError("subtitle ZIP contains no supported files")
            candidates.sort(
                key=lambda info: (
                    int(Path(info.filename).suffix.casefold() in {".srt", ".vtt"}),
                    -int(any(marker in info.filename.casefold() for marker in ("sample", "forced"))),
                    info.file_size,
                ),
                reverse=True,
            )
            selected = candidates[0]
            if selected.file_size > 5_000_000:
                raise GatewayError("subtitle file is unexpectedly large")
            return archive.read(selected), Path(selected.filename).name
    except zipfile.BadZipFile as error:
        raise GatewayError("invalid subtitle ZIP") from error


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "AppleSubtitleGateway"

    @property
    def gateway(self) -> SubtitleGateway:
        return self.server.gateway  # type: ignore[attr-defined]

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        prefix = f"/v1/{self.gateway.config.access_token}/apple/"
        if not parsed.path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        tail = parsed.path[len(prefix) :].split("/")
        if len(tail) != 2 or tail[1] != "reference.json":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            if not 2 <= length <= 8_192:
                raise GatewayError("invalid request body size", HTTPStatus.BAD_REQUEST)
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            playlist_url = str(value.get("playlist_url") or "") if isinstance(value, dict) else ""
            self.gateway.register_reference(tail[0], playlist_url)
            self.send_json({"ok": True, "version": APP_VERSION})
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"ok": False, "error": "invalid JSON"}, status=HTTPStatus.BAD_REQUEST)
        except GatewayError as error:
            self.send_json({"ok": False, "error": str(error)}, status=error.status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/healthz":
            self.send_json(
                {
                    "ok": True,
                    "version": APP_VERSION,
                    "subdl_configured": bool(self.gateway.config.subdl_api_key),
                    "gemini_configured": bool(self.gateway.config.gemini_api_key),
                }
            )
            return

        prefix = f"/v1/{self.gateway.config.access_token}/apple/"
        if not parsed.path.startswith(prefix):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        tail = parsed.path[len(prefix) :].split("/")
        if len(tail) != 2 or tail[1] not in {"playlist.m3u8", "subtitle.vtt", "status.json"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            media = MediaRequest.from_query(tail[0], query)
            if tail[1] == "playlist.m3u8":
                self.send_text(self.gateway.playlist(media, parsed.query), "application/vnd.apple.mpegurl", cache="private, max-age=60")
                return
            if tail[1] == "status.json":
                target = self.gateway.cache_path(media)
                metadata = self.gateway.metadata_path(media)
                self.send_json(
                    {
                        "asset_id": media.asset_id,
                        "cached": target.exists(),
                        "metadata": json.loads(metadata.read_text(encoding="utf-8")) if metadata.exists() else None,
                    }
                )
                return
            vtt, source = self.gateway.get_vtt(media)
            self.send_text(vtt, "text/vtt; charset=utf-8", cache="private, max-age=86400", headers={"X-Subtitle-Source": source})
        except GatewayError as error:
            LOG.warning("request failed asset=%s error=%s", tail[0] if tail else "?", error)
            self.send_json({"ok": False, "error": str(error)}, status=error.status)
        except Exception:
            LOG.exception("unexpected request failure")
            self.send_json({"ok": False, "error": "internal server error"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def log_message(self, fmt: str, *args: Any) -> None:
        redacted = re.sub(r"/v1/[^/]+/apple/", "/v1/[redacted]/apple/", fmt % args)
        LOG.info("%s %s", self.client_address[0], redacted)

    def send_json(self, value: Any, status: int = HTTPStatus.OK) -> None:
        self.send_text(json.dumps(value, ensure_ascii=False), "application/json; charset=utf-8", status=status, cache="no-store")

    def send_text(
        self,
        value: str,
        content_type: str,
        status: int = HTTPStatus.OK,
        cache: str = "no-store",
        headers: dict[str, str] | None = None,
    ) -> None:
        data = value.encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(data)


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], gateway: SubtitleGateway):
        super().__init__(address, RequestHandler)
        self.gateway = gateway


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config = Config.from_env()
    gateway = SubtitleGateway(config)
    server = GatewayServer((config.bind, config.port), gateway)
    LOG.info("starting version=%s bind=%s port=%s", APP_VERSION, config.bind, config.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
