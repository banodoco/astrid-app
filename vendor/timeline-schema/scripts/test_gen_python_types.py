import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mirror_check', Path(__file__).with_name('gen_python_types.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class MirrorCheckerTest(unittest.TestCase):
    def check_with(self, source):
        with tempfile.TemporaryDirectory() as directory:
            old = check.GENERATED
            try:
                check.GENERATED = Path(directory) / 'generated.py'
                check.GENERATED.write_text(source)
                with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
                    return check.main()
            finally:
                check.GENERATED = old

    def test_exact_canonical_mirror(self):
        self.assertEqual(self.check_with(check.GENERATED.read_text()), 0)

    def test_missing_or_wrong_alias_fails(self):
        source = check.GENERATED.read_text()
        for replacement in ('', 'MetaNamespaceKey = int', 'class MetaNamespaceKey(TypedDict): pass'):
            with self.subTest(replacement=replacement):
                self.assertEqual(self.check_with(source.replace('MetaNamespaceKey = str', replacement)), 1)

    def test_missing_object_field_fails_even_if_other_record_has_it(self):
        source = check.GENERATED.read_text().replace('    fit: Literal["contain", "cover"]\n', '')
        self.assertEqual(self.check_with(source + '\nclass Other(TypedDict):\n    fit: str\n'), 1)


if __name__ == '__main__':
    unittest.main()
