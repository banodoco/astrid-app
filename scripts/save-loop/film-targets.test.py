"""Checks fixture word target evidence and refusal of unrelated errors."""
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('film_builder', Path(__file__).with_name('film_builder.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TargetProofTests(unittest.TestCase):
    def check(self, retime, expected_ambiguous=False):
        return mod.prove_target(retime, ('occ', 'shot', 'visual'), {}, 'word',
                                'doc', ('occ', 'shot', 'narration'), 'word-id', expected_ambiguous)

    def test_unique_requires_exact_source_and_word(self):
        binding = SimpleNamespace(document_id='doc', source=('occ', 'shot', 'other'), word_ids=('word-id',))
        retime = SimpleNamespace(words=(['pool'], {}), bundle={}, resolve=lambda *args: (binding, None, None))
        with patch.object(mod.moments, 'find_words', return_value=[['hit']]), patch.object(mod, 'require_retime_word_scope'):
            with self.assertRaisesRegex(RuntimeError, 'unexpected word resolution'):
                self.check(retime)
            binding.source = ('occ', 'shot', 'narration')
            binding.word_ids = ('wrong',)
            with self.assertRaisesRegex(RuntimeError, 'unexpected word resolution'):
                self.check(retime)
            binding.word_ids = ('word-id',)
            self.assertEqual(self.check(retime), 'resolved')

    def test_repeat_requires_actual_multiple_matches_and_propagates_scope_errors(self):
        retime = SimpleNamespace(words=(['pool'], {}), bundle={})
        with patch.object(mod.moments, 'find_words', return_value=[['hit']]), patch.object(mod, 'require_retime_word_scope'):
            with self.assertRaisesRegex(RuntimeError, 'expected ambiguous word'):
                self.check(retime, True)
        with patch.object(mod, 'require_retime_word_scope', side_effect=ValueError('bad transcript')):
            with self.assertRaisesRegex(ValueError, 'bad transcript'):
                self.check(retime, True)
        with patch.object(mod.moments, 'find_words', return_value=[['a'], ['b']]), patch.object(mod, 'require_retime_word_scope'):
            self.assertEqual(self.check(retime, True), 'ambiguous')

    def test_unique_resolution_errors_propagate(self):
        def fail(*args):
            raise ValueError('unrelated failure')
        retime = SimpleNamespace(words=(['pool'], {}), bundle={}, resolve=fail)
        with patch.object(mod.moments, 'find_words', return_value=[['hit']]), patch.object(mod, 'require_retime_word_scope'):
            with self.assertRaisesRegex(ValueError, 'unrelated failure'):
                self.check(retime)


if __name__ == '__main__':
    unittest.main()
