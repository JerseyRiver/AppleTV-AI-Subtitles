import io
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from app import CaptionSample, Cue, MediaRequest, SubtitleGateway, VTT_TIMESTAMP_MAP, apply_alignment, authenticated_subdl_url, canonicalize_apple_url, dialogue_prefix_similarity, ensure_vtt_timestamp_map, estimate_alignment, extract_best_from_zip, is_netflix_release, parse_ass, parse_srt_or_vtt, release_frame_rate, releases_compatible, render_vtt, undo_legacy_alignment


class SubtitleTests(unittest.TestCase):
    def test_srt_to_vtt(self):
        source = "1\n00:00:01,250 --> 00:00:03,500\n<i>Hello</i> &amp; goodbye\n\n"
        cues = parse_srt_or_vtt(source)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "Hello & goodbye")
        self.assertIn("00:00:01.250 --> 00:00:03.500", render_vtt(cues))

    def test_ass_to_vtt(self):
        source = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.10,0:00:04.20,Default,,0,0,0,,{\\i1}Hello\\Nworld\n"
        cues = parse_ass(source)
        self.assertEqual(cues, [Cue(2100, 4200, "Hello\nworld")])

    def test_zip_selection_avoids_forced_sample(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("movie.forced.srt", "x")
            archive.writestr("movie.full.srt", "full subtitle")
        data, name = extract_best_from_zip(output.getvalue())
        self.assertEqual(name, "movie.full.srt")
        self.assertEqual(data, b"full subtitle")

    def test_media_request_validation(self):
        media = MediaRequest.from_query(
            "6794539309",
            {
                "title": ["Rocketman"],
                "year": ["2019"],
                "duration": ["7334"],
                "frame_rate": ["23.976"],
                "type": ["Movie"],
            },
        )
        self.assertEqual(media.title, "Rocketman")
        self.assertEqual(media.year, 2019)
        self.assertEqual(media.duration, 7334)
        self.assertEqual(media.media_type, "movie")
        self.assertEqual(media.discontinuity_sequence, 0)
        self.assertEqual(media.frame_rate, 23.976)

    def test_apple_timestamp_map_preserves_cue_times(self):
        rendered = render_vtt([Cue(1000, 2500, "Hello")])
        self.assertIn(VTT_TIMESTAMP_MAP, rendered)
        self.assertIn("00:00:01.000 --> 00:00:02.500", rendered)

    def test_legacy_cache_gets_timestamp_map_without_shifting(self):
        legacy = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n"
        normalized = ensure_vtt_timestamp_map(legacy)
        self.assertIn(VTT_TIMESTAMP_MAP, normalized)
        self.assertIn("00:00:01.000 --> 00:00:02.500", normalized)

    def test_candidate_prefers_matching_simplified_release(self):
        traditional = {
            "release_name": "Movie.720p.BluRay.x264-SPARKS",
            "name": "subtitle.zip",
            "unpack_files": [{"name": "Movie.cmnHant.srt", "release_name": "Movie.cmnHant"}],
        }
        simplified = {
            "release_name": "Movie.720p.BluRay.x264-SPARKS",
            "name": "subtitle.zip",
            "unpack_files": [{"name": "Movie.cmnHans.srt", "release_name": "Movie.cmnHans"}],
        }
        preferred = "subdl:EN+gemini:Movie.720p.BluRay.x264-SPARKS-HI"
        self.assertGreater(
            SubtitleGateway.candidate_score(simplified, preferred),
            SubtitleGateway.candidate_score(traditional, preferred),
        )

    def test_candidate_prefers_apple_release_over_netflix(self):
        apple = {"release_name": "Movie.2020.ATVP.WEB-DL", "name": "Movie.cmnHans.srt"}
        netflix = {"release_name": "Movie.2020.Netflix.WEBRip", "name": "Movie.cmnHans.srt"}
        self.assertGreater(SubtitleGateway.candidate_score(apple), SubtitleGateway.candidate_score(netflix))

    def test_same_release_languages_are_compatible(self):
        self.assertTrue(
            releases_compatible(
                "Catch.Me.If.You.Can.2002.WEBRip.Netflix.chs.srt",
                "Catch.Me.If.You.Can.2002.WEBRip.NF.English.srt",
            )
        )

    def test_different_release_platforms_are_not_compatible(self):
        self.assertFalse(
            releases_compatible(
                "Example.Movie.2020.ATVP.WEB-DL.chs.srt",
                "Example.Movie.2020.Netflix.WEBRip.en.srt",
            )
        )

    def test_subdl_key_is_removed_from_download_url(self):
        url = authenticated_subdl_url("/subtitle/example/file?api_key=secret&format=srt")
        self.assertNotIn("secret", url)
        self.assertIn("format=srt", url)

    def test_playlist_versions_the_vtt_url(self):
        gateway = object.__new__(SubtitleGateway)
        media = MediaRequest("6794539309", "Rocketman", 2019, 7334, "movie", None, None, 3)
        playlist = gateway.playlist(media, "title=Rocketman")
        self.assertIn("subtitle.vtt?title=Rocketman&gateway_version=0.11.1", playlist)
        self.assertIn("#EXT-X-DISCONTINUITY-SEQUENCE:3", playlist)

    def test_apple_playback_alias_is_canonicalized(self):
        value = canonicalize_apple_url("https://play-edge-cdn.itunes.apple.com/path/playlist.m3u8?a=1")
        self.assertEqual(value, "https://play-edge.itunes.apple.com/path/playlist.m3u8?a=1")

    def test_alignment_estimates_constant_offset(self):
        lines = [
            "The first uniquely spoken sentence",
            "A second distinctive line of dialogue",
            "Nobody expected this particular answer",
            "We should leave before the morning train",
            "The documents are waiting in the office",
            "Tell everyone the meeting is cancelled",
            "This conversation was never recorded",
            "Please close the door when you depart",
        ]
        reference = [Cue(index * 60_000, index * 60_000 + 2_000, text) for index, text in enumerate(lines)]
        captions = [CaptionSample(cue.start_ms + 10_900, cue.text) for cue in reference]
        alignment = estimate_alignment(captions, reference)
        self.assertIsNotNone(alignment)
        self.assertEqual(alignment.mode, "offset")
        self.assertAlmostEqual(alignment.offset_ms, 900, delta=1)
        translated = [Cue(0, 2_000, "译文")]
        apply_alignment(translated, alignment)
        self.assertEqual((translated[0].start_ms, translated[0].end_ms), (900, 2_900))

    def test_alignment_rejects_unrelated_text(self):
        reference = [Cue(index * 60_000, index * 60_000 + 2_000, f"source sentence number {index}") for index in range(8)]
        captions = [CaptionSample(index * 60_000 + 10_500, f"completely different words {index}") for index in range(8)]
        self.assertIsNone(estimate_alignment(captions, reference))

    def test_alignment_uses_affine_drift_for_a_consistent_clock_change(self):
        reference = [
            Cue(index * 120_000, index * 120_000 + 2_000, f"A distinctive dialogue sentence number {index}")
            for index in range(20)
        ]
        offsets = [1_200] * 4 + [800] * 4 + [200] * 4 + [-400] * 4 + [-800] * 4
        captions = [CaptionSample(cue.start_ms + 10_000 + offsets[index], cue.text) for index, cue in enumerate(reference)]
        alignment = estimate_alignment(captions, reference)
        self.assertIsNotNone(alignment)
        self.assertEqual(alignment.mode, "affine")
        self.assertEqual(len(alignment.anchors), 0)
        early = [Cue(120_000, 122_000, "译文")]
        apply_alignment(early, alignment)
        self.assertAlmostEqual(early[0].start_ms, 121_200, delta=100)

    def test_caption_continuation_is_not_a_start_anchor(self):
        self.assertGreater(
            dialogue_prefix_similarity("The only thing I need", "The only thing I need for midnight"),
            0.9,
        )
        self.assertLess(
            dialogue_prefix_similarity("for my midnight shift", "The only thing I need for my midnight shift"),
            0.72,
        )

    def test_alignment_prefers_first_caption_after_dialogue_gap(self):
        reference = []
        captions = []
        for group in range(6):
            start = group * 60_000
            first = f"The opening sentence for dialogue group number {group}"
            continuation = f"The following fragment for dialogue group number {group}"
            reference.extend(
                [
                    Cue(start, start + 1_500, first),
                    Cue(start + 2_000, start + 3_500, continuation),
                ]
            )
            captions.extend(
                [
                    CaptionSample(start + 10_800, first),
                    CaptionSample(start + 11_000, continuation),
                ]
            )
        alignment = estimate_alignment(captions, reference)
        self.assertIsNotNone(alignment)
        self.assertEqual(alignment.mode, "offset")
        self.assertAlmostEqual(alignment.offset_ms, 800, delta=1)

    def test_sparse_paragraph_anchors_can_prove_clock_drift(self):
        points = [226_758, 688_720, 2_279_976, 3_225_462, 5_363_098, 6_413_606]
        offsets = [855, 1_289, 1_986, 113, -355, -517]
        reference = [
            Cue(point - 10_000, point - 8_000, f"A unique paragraph opening number {index}")
            for index, point in enumerate(points)
        ]
        captions = [
            CaptionSample(point + offsets[index], f"A unique paragraph opening number {index}")
            for index, point in enumerate(points)
        ]
        alignment = estimate_alignment(captions, reference)
        self.assertIsNotNone(alignment)
        self.assertEqual(alignment.mode, "affine")
        self.assertAlmostEqual(alignment.scale, 0.9997644, delta=0.00001)
        self.assertLess(alignment.residual_ms, 100)

    def test_release_frame_rate_and_netflix_detection(self):
        self.assertEqual(release_frame_rate("Movie.2020.23.976fps.BluRay"), 23.976)
        self.assertEqual(release_frame_rate("Movie.2020.PAL.DVDRip"), 25.0)
        self.assertTrue(is_netflix_release("Movie.2020.WEBRip.Netflix"))
        self.assertTrue(is_netflix_release("Movie.2020.NF.WEB-DL"))
        self.assertFalse(is_netflix_release("Movie.2020.BluRay.REMUX"))

    def test_english_selection_excludes_netflix(self):
        lines = [f"A distinctive spoken sentence number {index}" for index in range(8)]
        bluray_cues = [Cue(index * 60_000, index * 60_000 + 2_000, text) for index, text in enumerate(lines)]
        netflix_cues = [Cue(cue.start_ms, cue.end_ms, cue.text) for cue in bluray_cues]
        captions = [CaptionSample(cue.start_ms + 10_500, cue.text, cue.end_ms + 10_500) for cue in bluray_cues]

        class Selector(SubtitleGateway):
            def search_subdl(self, media, language, identity, preferred_release=""):
                return [
                    {"release_name": "Movie.2020.Netflix.WEBRip", "name": "netflix.srt", "unpack_files": [{}]},
                    {"release_name": "Movie.2020.23.976fps.BluRay.REMUX", "name": "bluray.srt", "unpack_files": [{}]},
                ]

            def fetch_apple_captions(self, media):
                return captions

            def download_candidate_cached(self, media, item):
                cues = netflix_cues if "Netflix" in item["release_name"] else bluray_cues
                return render_vtt(cues).encode(), item["name"], item["release_name"]

        gateway = object.__new__(Selector)
        media = MediaRequest("6794539309", "Movie", 2020, 480, "movie", None, None, 0, 23.976)
        _, label, alignment, details = gateway.select_english_reference(media, {}, "")
        self.assertIn("BluRay", label)
        self.assertNotIn("Netflix", label)
        self.assertIsNotNone(alignment)
        self.assertEqual(details["source_frame_rate"], 23.976)

    def test_candidate_cache_uses_distinct_atomic_temp_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            gateway = object.__new__(SubtitleGateway)
            gateway.config = SimpleNamespace(cache_dir=Path(temporary_directory))
            gateway.download_candidate = lambda item: (
                b"1\n00:00:01,000 --> 00:00:02,000\nHello\n",
                "Movie.srt",
                "Movie.2020.BluRay",
            )
            media = MediaRequest("6794539309", "Movie", 2020, 120, "movie", None, None, 0)
            item = {"url": "/subtitle/movie", "name": "Movie.srt", "release_name": "Movie.2020.BluRay"}

            first = gateway.download_candidate_cached(media, item)
            candidate_directory = Path(temporary_directory) / media.asset_id / "candidates"
            self.assertEqual(len(list(candidate_directory.glob("*.subtitle"))), 1)
            self.assertEqual(len(list(candidate_directory.glob("*.json"))), 1)
            self.assertEqual(list(candidate_directory.glob("*.tmp")), [])

            gateway.download_candidate = lambda item: self.fail("candidate should be read from cache")
            self.assertEqual(gateway.download_candidate_cached(media, item), first)

    def test_legacy_alignment_can_be_undone(self):
        cues = [Cue(1_500, 2_500, "译文")]
        undo_legacy_alignment(cues, {"version": 1, "status": "applied", "scale": 1.0, "offset_ms": 500})
        self.assertEqual((cues[0].start_ms, cues[0].end_ms), (1_000, 2_000))

    def test_old_resolver_cache_is_preserved_until_deliberate_rebuild(self):
        gateway = object.__new__(SubtitleGateway)
        gateway.read_metadata = lambda media: {
            "resolver": "subdl-v4-english-first",
            "alignment": {"version": 1, "status": "applied", "attempted_at": int(time.time())},
        }
        gateway.read_reference = lambda media: "https://play.itunes.apple.com/reference.m3u8"
        media = MediaRequest("6794539309", "Rocketman", 2019, 7334, "movie", None, None, 3)
        self.assertFalse(gateway.should_align_cached(media))

    def test_gemini_missing_ids_are_repaired(self):
        class RepairGateway(SubtitleGateway):
            def __init__(self):
                self.config = SimpleNamespace(gemini_batch_size=3, gemini_concurrency=1)
                self.calls = 0

            def translate_batch(self, items):
                self.calls += 1
                if self.calls == 1:
                    return {item["id"]: f"译文{item['id']}" for item in items[:-1]}
                return {item["id"]: f"补译{item['id']}" for item in items}

        gateway = RepairGateway()
        cues = [Cue(0, 1000, "one"), Cue(1000, 2000, "two"), Cue(2000, 3000, "three")]
        gateway.translate_cues(cues)
        self.assertEqual([cue.text for cue in cues], ["译文0", "译文1", "补译2"])
        self.assertEqual(gateway.calls, 2)


if __name__ == "__main__":
    unittest.main()
