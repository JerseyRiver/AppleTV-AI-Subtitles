import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from app import Cue, GatewayError, MediaRequest, SubtitleGateway


class RetryGateway(SubtitleGateway):
    def __init__(self, root):
        super().__init__(SimpleNamespace(cache_dir=root))
        self.resolutions = 0
        self.fail = False

    def should_align_cached(self, media):
        return False

    def resolve(self, media, preferred_release=""):
        self.resolutions += 1
        time.sleep(0.01)
        if self.fail:
            raise GatewayError('mock upstream failure')
        return [Cue(1000, 3000, f'fresh translation {self.resolutions}')], 'mock', [], None, {}

    def align_cues(self, *args):
        return {'status': 'skipped'}

    def prune_cache(self):
        pass


class RetryTests(unittest.TestCase):
    def test_retry_token_query_validation(self):
        media = MediaRequest.from_query('1234567890', {'title': ['Synthetic'], 'retry': ['a' * 32]})
        self.assertEqual(media.retry_token, 'a' * 32)
        gateway = object.__new__(SubtitleGateway)
        self.assertIn('retry=' + 'a' * 32, gateway.playlist(media, 'retry=' + 'a' * 32))
        with self.assertRaises(GatewayError):
            MediaRequest.from_query('1234567890', {'title': ['Synthetic'], 'retry': ['../invalid']})

    def test_one_request_rebuilds_one_movie_and_keeps_new_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway = RetryGateway(Path(folder))
            media = MediaRequest('1234567890', 'Synthetic', 2020, 7200, 'movie', None, None, 0)
            other = replace(media, asset_id='2234567890')
            old, _ = gateway.get_vtt(media)
            gateway.get_vtt(other)
            other_before = gateway.cache_path(other).read_bytes()
            retry = replace(media, retry_token='a' * 32)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: gateway.get_vtt(retry), range(4)))
            self.assertEqual(gateway.resolutions, 3, 'Concurrent retry triggered multiple rebuilds')
            self.assertTrue(all(value[0] == results[0][0] for value in results))
            self.assertNotEqual(old, results[0][0])
            self.assertEqual(gateway.get_vtt(media)[0], results[0][0], 'No-token request restored old result')
            self.assertEqual(gateway.cache_path(other).read_bytes(), other_before)
            newer, _ = gateway.get_vtt(replace(media, retry_token='b' * 32))
            self.assertEqual(gateway.resolutions, 4)
            self.assertEqual(gateway.get_vtt(retry)[0], newer, 'Late old token rebuilt over newer subtitles')
            self.assertEqual(gateway.resolutions, 4)
            self.assertEqual(gateway.read_metadata(media)['retry_tokens'], ['a' * 32, 'b' * 32])

    def test_failed_retry_preserves_old_movie_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway = RetryGateway(Path(folder))
            media = MediaRequest('1234567890', 'Synthetic', 2020, 7200, 'movie', None, None, 0)
            old, _ = gateway.get_vtt(media)
            original = gateway.cache_path(media).parent / 'unaligned.vtt'
            original_before = original.read_bytes()
            metadata_before = gateway.metadata_path(media).read_bytes()
            retry = replace(media, retry_token='c' * 32)
            gateway.fail = True
            with self.assertRaises(GatewayError):
                gateway.get_vtt(retry)
            self.assertEqual(gateway.get_vtt(media)[0], old)
            self.assertEqual(original.read_bytes(), original_before)
            self.assertEqual(gateway.metadata_path(media).read_bytes(), metadata_before)
            gateway.fail = False
            fresh, _ = gateway.get_vtt(retry)
            self.assertNotEqual(fresh, old)


if __name__ == '__main__':
    unittest.main()
