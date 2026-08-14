"""Private command line boundary for the packaged engine."""

import argparse
import contextlib
import json
import os
import sys
import time
from pathlib import Path

from flyingmouse_docstructure import __version__
from flyingmouse_docstructure.normalize import ResourceLimitError
from flyingmouse_docstructure.pipeline import (InvalidOutputError, MissingModelError, ParseError,
                                                build_pipeline, validate_manifest_limits)


def _status(code: str, page_count: int, started: float) -> None:
    payload = {"code": code, "engineVersion": __version__, "pageCount": page_count,
               "elapsedMs": max(0, round((time.monotonic() - started) * 1000))}
    sys.stderr.write(json.dumps(payload, separators=(",", ":")) + "\n")


def _clean_output(output: Path) -> None:
    if not output.exists() or output.is_symlink() or not output.is_dir():
        return
    for child in output.iterdir():
        attributes = getattr(child.lstat(), "st_file_attributes", 0)
        if child.is_file() and not child.is_symlink() and not attributes & 0x400:
            child.unlink(missing_ok=True)


def _prepare_output(output: Path) -> None:
    try:
        if output.exists():
            attributes = getattr(output.lstat(), "st_file_attributes", 0)
            if not output.is_dir() or output.is_symlink() or attributes & 0x400:
                raise InvalidOutputError()
        else:
            output.mkdir(parents=True)
        if not output.resolve(strict=True).is_dir(): raise InvalidOutputError()
        for child in output.iterdir():
            attributes = getattr(child.lstat(), "st_file_attributes", 0)
            if not child.is_file() or child.is_symlink() or attributes & 0x400:
                raise InvalidOutputError()
    except InvalidOutputError:
        raise
    except OSError as error:
        raise InvalidOutputError() from error


def _atomic_manifest(output: Path, manifest: dict) -> None:
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    if len(encoded) > 512 * 1024 * 1024:
        raise ResourceLimitError()
    temporary = output / ".manifest.json.tmp"
    try:
        with temporary.open("xb") as stream:
            stream.write(encoded); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, output / "manifest.json")
    except OSError as error:
        try: temporary.unlink(missing_ok=True)
        except OSError: pass
        raise InvalidOutputError() from error


@contextlib.contextmanager
def _private_engine_io():
    saved_stdout, saved_stderr = os.dup(1), os.dup(2)
    try:
        with open(os.devnull, "w", encoding="utf-8") as private_sink:
            os.dup2(private_sink.fileno(), 1); os.dup2(private_sink.fileno(), 2)
            with contextlib.redirect_stdout(private_sink), contextlib.redirect_stderr(private_sink):
                yield
    finally:
        os.dup2(saved_stdout, 1); os.dup2(saved_stderr, 2)
        os.close(saved_stdout); os.close(saved_stderr)


def _parser() -> argparse.ArgumentParser:
    class PrivateParser(argparse.ArgumentParser):
        def error(self, message):
            raise argparse.ArgumentError(None, message)

    parser = PrivateParser(add_help=False, exit_on_error=False)
    sub = parser.add_subparsers(dest="command", required=True)
    parse = sub.add_parser("parse", add_help=False, exit_on_error=False)
    parse.add_argument("--input", required=True)
    parse.add_argument("--output", required=True)
    parse.add_argument("--models", required=True)
    parse.add_argument("--language", required=True, choices=("ch", "en"))
    return parser


def main(argv=None) -> int:
    started = time.monotonic(); output = None; pages = []; pipeline = None
    try:
        tokens = list(sys.argv[1:] if argv is None else argv)
        if "--models" not in tokens: raise MissingModelError()
        try:
            args = _parser().parse_args(tokens)
        except (argparse.ArgumentError, SystemExit):
            raise ParseError()
        output = Path(args.output)
        _prepare_output(output)
        with _private_engine_io():
            pipeline = build_pipeline(Path(args.models), args.language)
            pages = pipeline.parse(Path(args.input), output)
        validate_manifest_limits(pages)
        manifest = {"schemaVersion": 1,
                    "engine": {"name": "pp-structure-v3", "version": __version__},
                    "pages": pages}
        _atomic_manifest(output, manifest)
        if pipeline is not None and hasattr(pipeline, "close"):
            pipeline.close(); pipeline = None
        _status("OK", len(pages), started); return 0
    except MissingModelError:
        code, label = 20, "MODEL_MISSING"
    except ResourceLimitError:
        code, label = 23, "RESOURCE_LIMIT"
    except InvalidOutputError:
        code, label = 22, "INVALID_OUTPUT"
    except Exception:
        code, label = 21, "PARSE_FAILED"
    if output is not None:
        try: _clean_output(output)
        except Exception: pass
    if pipeline is not None and hasattr(pipeline, "close"):
        try: pipeline.close()
        except Exception: pass
    _status(label, len(pages), started)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
