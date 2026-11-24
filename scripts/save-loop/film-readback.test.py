"""Unit tests for the post-build readback check; astrid is stubbed (no Runtime is needed)."""
import sys, types, unittest
from pathlib import Path
from unittest import mock

stubs = ['astrid', 'astrid.sdk', 'astrid.sdk.authoring_media', 'astrid.sdk.media_transcript', 'astrid.sdk.timeline',
         'astrid.sdk.timeline.commit', 'astrid.sdk.timeline.native_source_inputs', 'astrid.sdk.timeline.native_word_anchor',
         'astrid.sdk.timeline._shot_word_retime', 'astrid.core', 'astrid.core.timeline', 'astrid.core.timeline.authoring_bundle']
with mock.patch.dict(sys.modules, {name: mock.MagicMock() for name in stubs}):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import film_builder

def saved(content_end, occurrence_end):
    return {'parent': {'clips': [{'at': 10, 'hold': 2}]},
            'placements': [{'shot_id': 's', 'placement': {'start_ms': 0}, 'duration_ms': int(occurrence_end * 1000)}],
            'shots': {'s': {'internal_timeline': {'clips': [{'at': 0, 'hold': content_end}]}}}}

class Readback(unittest.TestCase):
    def test_extents_are_reported_separately(self):
        self.assertEqual(film_builder.readback_extents(saved(18, 195.967)),
                         {'content_extent_seconds': 18.0, 'occurrence_extent_seconds': 195.967})

    def plan(self, **over):
        return {'shots': 1, 'child_clips': 1, 'parent_clips': 1, 'content_extent_seconds': 18.0,
                'occurrence_extent_seconds': 195.967, **over}

    def accepted(self, **over):
        return {'shots': 1, 'child_clips': 1, 'parent_clips': 1, **film_builder.readback_extents(saved(18, 195.967)), **over}

    def test_matching_head_passes_with_short_children(self):
        film_builder.verify_readback(self.plan(), self.accepted())

    def test_mismatches_fail_clearly(self):
        for over, text in ({'shots': 2}, 'shots'), ({'child_clips': 9}, 'child_clips'), ({'parent_clips': 0}, 'parent_clips'), \
                ({'content_extent_seconds': 196.0}, 'content_extent_seconds'), ({'occurrence_extent_seconds': 190.0}, 'occurrence_extent_seconds'):
            with self.assertRaisesRegex(RuntimeError, 'does not match the planned fixture.*' + text):
                film_builder.verify_readback(self.plan(), self.accepted(**over))

if __name__ == '__main__':
    unittest.main()
