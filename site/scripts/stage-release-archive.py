"""Stage an already-verified release ZIP under a caller-owned directory."""

import argparse
import ntpath
import os
from pathlib import Path
import stat
import struct
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
MAX_CENTRAL_BYTES = 16 * 1024**2
CENTRAL_FIELDS = struct.Struct("<4s24x3H")
LOCAL_LENGTHS = struct.Struct("<2H")


def check_central_directory(stream):
    # Use the same classic/Zip64 trailer reader as ZipFile so the bounds cover
    # the exact directory that its eager parser will load.
    trailer = zipfile._EndRecData(stream)
    if trailer is None:
        raise zipfile.BadZipFile("File is not a zip file")
    size = trailer[zipfile._ECD_SIZE]
    if size > MAX_CENTRAL_BYTES:
        raise ValueError("ZIP central directory exceeds its size limit")
    trailer_start = trailer[zipfile._ECD_LOCATION]
    if trailer[zipfile._ECD_SIGNATURE] == zipfile.stringEndArchive64:
        # Older CPython reports the classic marker even for a Zip64 trailer.
        stream.seek(trailer_start)
        if stream.read(len(zipfile.stringEndArchive)) == zipfile.stringEndArchive:
            trailer_start -= zipfile.sizeEndCentDir64 + zipfile.sizeEndCentDir64Locator
    start = trailer_start - size
    if (
        start < 0
        or start != trailer[zipfile._ECD_OFFSET]
        or trailer[zipfile._ECD_DISK_NUMBER]
        or trailer[zipfile._ECD_DISK_START]
    ):
        raise zipfile.BadZipFile("Invalid ZIP central directory location")
    stream.seek(start)
    data = stream.read(size)
    position = count = 0
    while position + zipfile.sizeCentralDir <= len(data):
        signature, filename, extra, comment = CENTRAL_FIELDS.unpack_from(data, position)
        if signature != zipfile.stringCentralDir:
            raise zipfile.BadZipFile("Invalid ZIP central directory entry")
        position += zipfile.sizeCentralDir + filename + extra + comment
        count += 1
        if count > MAX_PATHS:
            raise ValueError("ZIP central directory exceeds its entry count limit")
    if (
        position != size
        or len(data) != size
        or count != trailer[zipfile._ECD_ENTRIES_TOTAL]
        or count != trailer[zipfile._ECD_ENTRIES_THIS_DISK]
    ):
        raise zipfile.BadZipFile("Invalid ZIP central directory size or count")


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


def member_chunks(stream, archive, member):
    # ZipFile validates the local name and header. Its stream clips output to
    # the advertised size, so use the compressed span to verify real EOF.
    archive.open(member).close()
    stream.seek(member.header_offset + 26)
    name_bytes, extra_bytes = LOCAL_LENGTHS.unpack(stream.read(LOCAL_LENGTHS.size))
    stream.seek(name_bytes + extra_bytes, os.SEEK_CUR)
    decoder = (
        zlib.decompressobj(-zlib.MAX_WBITS)
        if member.compress_type == zipfile.ZIP_DEFLATED
        else None
    )
    remaining = member.compress_size
    written = crc = 0
    while remaining:
        block = stream.read(min(remaining, CHUNK_BYTES))
        if not block:
            raise zipfile.BadZipFile(f"incomplete ZIP member: {member.filename!r}")
        remaining -= len(block)
        while block:
            if decoder is None:
                chunk, block = block, b""
            else:
                chunk = decoder.decompress(block, CHUNK_BYTES)
                block = decoder.unconsumed_tail
                if decoder.unused_data or (decoder.eof and remaining):
                    raise zipfile.BadZipFile(f"invalid DEFLATE span: {member.filename!r}")
            written += len(chunk)
            if written > member.file_size:
                raise zipfile.BadZipFile(f"incomplete ZIP member: {member.filename!r}")
            crc = zlib.crc32(chunk, crc)
            if chunk:
                yield chunk
    if written != member.file_size or (decoder is not None and not decoder.eof):
        raise zipfile.BadZipFile(f"incomplete ZIP member: {member.filename!r}")
    if crc != member.CRC:
        raise zipfile.BadZipFile(f"Bad CRC for ZIP member: {member.filename!r}")


def stage_release_archive(archive_path, destination):
    if os.path.lexists(destination):
        raise ValueError("destination already exists")
    with archive_path.open("rb") as stream:
        check_central_directory(stream)
        with zipfile.ZipFile(stream) as archive:
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
                    chunks = member_chunks(stream, archive, member)
                    if member.is_dir():
                        next(chunks, None)
                        continue
                    with staged.joinpath(*parts).open("xb") as output:
                        output.writelines(chunks)
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
