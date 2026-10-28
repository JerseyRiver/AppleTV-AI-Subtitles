import io
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import GatewayError, SubtitleGateway, atomic_write, request_bytes


class Response:
    def __init__(self, body, headers=None):
        self.body = io.BytesIO(body)
        self.headers = headers or {}
        self.read_sizes = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.body.close()

    def read(self, size):
        self.read_sizes.append(size)
        return self.body.read(size)


class SafetyTests(unittest.TestCase):
    def test_declared_oversize_is_not_read(self):
        response = Response(b'body', {'Content-Length': '100000000'})
        with patch('app.urllib.request.urlopen', return_value=response):
            with self.assertRaises(GatewayError):
                request_bytes('https://example.com/subtitle', 5, max_bytes=32)
        self.assertEqual(response.read_sizes, [])

    def test_chunked_oversize_is_stopped_while_reading(self):
        response = Response(b'x' * 1000)
        with patch('app.urllib.request.urlopen', return_value=response):
            with self.assertRaises(GatewayError):
                request_bytes('https://example.com/subtitle', 5, max_bytes=32)
        self.assertEqual(sum(response.read_sizes), 33)

    def test_body_at_limit_is_valid(self):
        response = Response(b'x' * 32)
        with patch('app.urllib.request.urlopen', return_value=response):
            data, _ = request_bytes('https://example.com/subtitle', 5, max_bytes=32)
        self.assertEqual(data, b'x' * 32)

    def test_concurrent_reference_writes_are_complete_and_independent(self):
        with tempfile.TemporaryDirectory() as folder:
            gateway = SubtitleGateway(SimpleNamespace(cache_dir=Path(folder)))
            with ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(lambda n: gateway.register_reference('1234567890', f'https://play.itunes.apple.com/reference/{n}.m3u8'), range(40)))
            value = json.loads(gateway.reference_path('1234567890').read_text())
            self.assertTrue(value['url'].endswith('.m3u8'))
            self.assertEqual(list(Path(folder).rglob('*.tmp')), [])

    def test_failed_replace_preserves_old_file_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'subtitle.vtt'
            atomic_write(path, 'original')
            with patch('app.os.replace', side_effect=OSError('simulated disk failure')):
                with self.assertRaises(OSError):
                    atomic_write(path, 'new')
            self.assertEqual(path.read_text(), 'original')
            self.assertEqual(list(Path(folder).glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()
