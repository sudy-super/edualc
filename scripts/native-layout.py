"""Read Bun's embedded file table without executing the target binary."""
import hashlib
from pathlib import PurePosixPath
import re
import struct

PREFIX = b"/$bunfs/root/"
JS_HEADER = b"// @bun @bytecode\n"
RECORD_SIZE = 52
# Bun serializes loader, module format and encoding in the last four bytes.
SUPPORTED_FLAGS = {65793, 16778496, 16780545, 16780546, 16779776}


def _segment(data):
    if data[:4] != b"\xcf\xfa\xed\xfe" or len(data) < 32:
        raise ValueError("Expected a 64-bit little-endian Mach-O binary")
    count, size = struct.unpack_from("<II", data, 16)
    end = 32 + size
    if end > len(data):
        raise ValueError("Mach-O load commands outside binary")
    at, segments = 32, []
    for _ in range(count):
        if at + 8 > end:
            raise ValueError("Truncated Mach-O load command")
        command, length = struct.unpack_from("<II", data, at)
        if length < 8 or at + length > end:
            raise ValueError("Invalid Mach-O load command")
        if command == 0x19:
            if length < 72:
                raise ValueError("Truncated LC_SEGMENT_64")
            if data[at + 8:at + 24].rstrip(b"\0") == b"__BUN":
                offset, length_in_file = struct.unpack_from("<QQ", data, at + 40)
                if offset < end or length_in_file < 8 or offset + length_in_file > len(data):
                    raise ValueError("Invalid __BUN segment bounds")
                segments.append((offset, length_in_file))
        at += length
    if at != end or len(segments) != 1:
        raise ValueError("Expected exactly one valid __BUN segment")
    return segments[0]


def _relative(path):
    name = path[len(PREFIX):].decode("utf-8", errors="strict")
    if not path.startswith(PREFIX) or not name or any(p in ("", ".", "..") for p in name.split("/")) or "\\" in name or "\0" in name or PurePosixPath(name).is_absolute():
        raise ValueError("Unsafe embedded path")
    return name


def parse_records(data):
    offset, size = _segment(data)
    base, end = offset + 8, offset + size

    def bounds(relative, length):
        return relative >= 0 and length >= 0 and base + relative <= end and length <= end - base - relative

    def fields(at):
        if at < base or at + RECORD_SIZE > end:
            return None
        return struct.unpack_from("<13I", data, at)

    def path_record(at):
        v = fields(at)
        if v is None or not v[1] or not bounds(v[0], v[1] + 1):
            return False
        path = data[base + v[0]:base + v[0] + v[1] + 1]
        return path.startswith(PREFIX) and path.endswith(b"\0") and b"\0" not in path[:-1]

    # Tail chunk names survive chunk renaming and changes in the number of files.
    region = data[offset:end]
    tail = list(re.finditer(rb"/\$bunfs/root/chunk-[a-zA-Z0-9_-]+\.js\x00", region))[-30:]
    starts = set()
    for match in tail:
        pointer = struct.pack("<II", match.start() - 8, len(match.group()) - 1)
        search = 0
        while True:
            hit = region.find(pointer, search)
            if hit < 0:
                break
            search = hit + 1
            at = offset + hit
            v = fields(at)
            if v is None or v[12] != 65793 or not bounds(v[2], len(JS_HEADER)) or data[base + v[2]:base + v[2] + len(JS_HEADER)] != JS_HEADER:
                continue
            while path_record(at - RECORD_SIZE):
                at -= RECORD_SIZE
            starts.add(at)
    if len(starts) != 1:
        raise ValueError(f"Expected one metadata table; found {len(starts)}")
    table = next(iter(starts))
    records, names, path_end, source_end = [], set(), None, 0
    at = table
    first_path = None
    while path_record(at):
        v = fields(at)
        if v[12] not in SUPPORTED_FLAGS or v[4:6] != (0, 0) or v[9] != 0:
            raise ValueError("Unsupported Bun record flags or fields")
        for relative, length in ((v[2], v[3] + 1), (v[6], v[7]), (v[8], 0), (v[10], v[11] + 1 if v[11] else 0)):
            if not bounds(relative, length):
                raise ValueError("Record range outside __BUN")
        path = data[base + v[0]:base + v[0] + v[1]]
        name = _relative(path)
        if name in names:
            raise ValueError("Duplicate embedded path")
        names.add(name)
        if path_end is not None and v[0] != path_end:
            raise ValueError("Discontinuous embedded path table")
        if first_path is None:
            first_path = v[0]
        path_end = v[0] + v[1] + 1
        if v[11]:
            extra = data[base + v[10]:base + v[10] + v[11] + 1]
            if v[10] != path_end or not extra.endswith(b"\0") or b"\0" in extra[:-1]:
                raise ValueError("Invalid embedded module path")
            _relative(extra[:-1])
            path_end += v[11] + 1
        source = data[base + v[2]:base + v[2] + v[3]]
        if data[base + v[2] + v[3]] != 0:
            raise ValueError("Unterminated embedded source")
        javascript = v[12] == 65793
        if javascript != source.startswith(JS_HEADER):
            raise ValueError("Invalid JavaScript metadata")
        if v[6] + v[7] > v[2]:
            raise ValueError("Bytecode overlaps source")
        source_end = max(source_end, v[2] + v[3] + 1)
        records.append({"path": path.decode("utf-8"), "relative_path": name, "metadata_offset": at,
                        "source_offset": base + v[2], "source_size": v[3],
                        "source_sha256": hashlib.sha256(source).hexdigest(), "flags": v[12], "javascript": javascript})
        at += RECORD_SIZE
    # These adjacent regions make a damaged first or last record fail explicitly.
    if not records or first_path != source_end or base + path_end != table:
        raise ValueError("Incomplete embedded file table boundaries")
    return {"offset": offset, "size": size, "base": base, "table_offset": table}, records


def binary_version(data, records):
    versions = set()
    for record in records:
        if record["javascript"]:
            source = data[record["source_offset"]:record["source_offset"] + record["source_size"]]
            versions.update(m.decode("ascii") for m in re.findall(rb"(?m)^// Version: (\d+\.\d+\.\d+)\r?$", source))
    if len(versions) != 1:
        raise ValueError(f"Expected one Claude Code version; found {len(versions)}")
    return versions.pop()
