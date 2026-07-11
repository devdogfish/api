import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from media_normalization import SUPPORTED_AUDIO_EXTENSIONS, SUPPORTED_VIDEO_EXTENSIONS, normalize_media_file


class MediaNormalizationTests(unittest.TestCase):
    def test_supports_common_audio_and_video_extensions(self):
        self.assertIn('.mp3', SUPPORTED_AUDIO_EXTENSIONS)
        self.assertIn('.m4a', SUPPORTED_AUDIO_EXTENSIONS)
        self.assertIn('.opus', SUPPORTED_AUDIO_EXTENSIONS)
        self.assertIn('.flac', SUPPORTED_AUDIO_EXTENSIONS)
        self.assertIn('.mp4', SUPPORTED_VIDEO_EXTENSIONS)
        self.assertIn('.mov', SUPPORTED_VIDEO_EXTENSIONS)
        self.assertIn('.mkv', SUPPORTED_VIDEO_EXTENSIONS)

    def test_normalizes_supported_media_to_16khz_mono_wav(self):
        runner = Mock()
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / 'meeting.mp4'
            source.write_bytes(b'fake-media')

            normalized = normalize_media_file(source, runner=runner)

            self.assertEqual(normalized.suffix, '.wav')
            self.assertTrue(str(normalized).endswith('.normalized.wav'))
            runner.assert_called_once()
            command = runner.call_args.args[0]
            self.assertEqual(command[:2], ['ffmpeg', '-y'])
            self.assertIn(str(source), command)
            self.assertIn('-vn', command)
            self.assertIn('16000', command)
            self.assertEqual(command[-1], str(normalized))

    def test_rejects_unsupported_media_extensions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / 'notes.txt'
            source.write_text('not media')

            with self.assertRaises(ValueError):
                normalize_media_file(source)


if __name__ == '__main__':
    unittest.main()
