"""Stage an already-verified release ZIP under a caller-owned directory."""

import argparse
import ntpath
import os
from pathlib import Path
import stat
import sys
import tempfile
import unicodedata
import zipfile
import zlib

MAX_FILES = 20_000
MAX_PATHS = 2 * MAX_FILES
MAX_PATH_DEPTH = 64
MAX_FILE_BYTES = 25 * 1024**2
MAX_EXPANDED_BYTES = 5 * 1024**3 // 4
CHUNK_BYTES = 1024**2


def checked_members(archive):
    paths = {}
    visited = set()
    members = []
    file_count = total = 0
    for member in archive.infolist():
        name = member.orig_filename
        directory = member.is_dir()
        parts = tuple((name[:-1] if directory else name).split("/"))
        if (
            "\x00" in name
            or "\\" in name
            or ntpath.splitdrive(name)[0]
            or any(part in ("", ".", "..") for part in parts)
        ):
            raise ValueError(f"unsafe ZIP path: {name!r}")
        if len(parts) > MAX_PATH_DEPTH:
            raise ValueError(f"ZIP exceeds the path depth limit: {name!r}")
        mode = stat.S_IFMT(member.external_attr >> 16)
        if (
            mode not in (0, stat.S_IFDIR if directory else stat.S_IFREG)
            or (member.external_attr & 0x10 and not directory)
            or (directory and member.file_size)
            or member.flag_bits & 1
            or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
        ):
            raise ValueError(f"unsupported ZIP member: {name!r}")

        # Match common case-insensitive macOS filesystems without renaming assets.
        key = tuple(unicodedata.normalize("NFD", part).casefold() for part in parts)
        if key in visited:
            raise ValueError(f"conflicting ZIP path: {name!r}")
        visited.add(key)
        for depth in range(1, len(parts) + 1):
            identity = (parts[:depth], directory or depth < len(parts))
            if paths.setdefault(key[:depth], identity) != identity:
                raise ValueError(f"conflicting ZIP path: {name!r}")

        if not directory:
            file_count += 1
            if file_count > MAX_FILES:
                raise ValueError("ZIP exceeds the file count limit")
            if member.file_size > MAX_FILE_BYTES:
                raise ValueError(f"ZIP exceeds the per-file size limit: {name!r}")
            total += member.file_size
            if total > MAX_EXPANDED_BYTES:
                raise ValueError("ZIP exceeds the expanded size limit")
        if len(paths) > MAX_PATHS:
            raise ValueError("ZIP exceeds the path count limit")
        members.append((member, parts))
    if not file_count:
        raise ValueError("ZIP has no release files")
    directories = [parts for parts, directory in paths.values() if directory]
    return members, directories


def stage_release_archive(archive_path, destination):
    if os.path.lexists(destination):
        raise ValueError("destination already exists")
    with zipfile.ZipFile(archive_path) as archive:
        members, directories = checked_members(archive)
        # Use a private sibling so promotion is atomic on the destination filesystem.
        with tempfile.TemporaryDirectory(
            prefix=".release-archive-", dir=destination.parent
        ) as work_directory:
            staged = Path(work_directory) / "staged"
            staged.mkdir(mode=0o700)
            for parts in directories:
                staged.joinpath(*parts).mkdir()
            for member, parts in members:
                path = staged.joinpath(*parts)
                with archive.open(member) as source:
                    if member.is_dir():
                        source.read(1)
                        continue
                    written = 0
                    with path.open("xb") as output:
                        while chunk := source.read(CHUNK_BYTES):
                            written += output.write(chunk)
                    if written != member.file_size:
                        raise ValueError(f"incomplete ZIP member: {member.filename!r}")
            if os.path.lexists(destination):
                raise ValueError("destination already exists")
            staged.rename(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path, help="new path in a caller-owned parent")
    args = parser.parse_args()
    try:
        stage_release_archive(args.archive, args.destination)
    except (OSError, ValueError, EOFError, RuntimeError, zipfile.BadZipFile, zlib.error) as error:
        print(f"Cannot stage release ZIP: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
