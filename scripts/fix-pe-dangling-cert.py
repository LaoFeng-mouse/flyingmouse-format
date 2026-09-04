# Zero the dangling certificate directory entry (index 4: VA=0, Size=0) in PE files,
# turning them into plain unsigned PEs (their signed tail was truncated anyway).
# Usage: python fix-pe-dangling-cert.py <file.dll|exe> [...]   (prints before/after byte diff count)
import sys, struct, os

def cert_dir_off(f, size):
    f.seek(0)
    if f.read(2) != b"MZ":
        return None
    f.seek(0x3C)
    e_lfanew = struct.unpack("<I", f.read(4))[0]
    if e_lfanew + 26 > size:
        return None
    f.seek(e_lfanew)
    if f.read(4) != b"PE\x00\x00":
        return None
    f.seek(e_lfanew + 24)
    magic = struct.unpack("<H", f.read(2))[0]
    if magic == 0x10B:
        off = e_lfanew + 24 + 96 + 4 * 8
    elif magic == 0x20B:
        off = e_lfanew + 24 + 112 + 4 * 8
    else:
        return None
    return off if off + 8 <= size else None

def fix(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        off = cert_dir_off(f, size)
        if off is None:
            print(f"skip (not PE): {path}")
            return
        f.seek(off)
        va, csize = struct.unpack("<II", f.read(8))
        if csize == 0 or va + csize <= size:
            print(f"clean: {path} (va={va} size={csize})")
            return
        before = bytearray(f.read())  # not needed; just for byte-diff count below
    # patch 8 bytes in place
    with open(path, "r+b") as f:
        f.seek(off)
        f.write(struct.pack("<II", 0, 0))
    # verify + count changed bytes vs expectation: exactly the 8-byte entry zeroed
    with open(path, "rb") as f:
        f.seek(off)
        va2, cs2 = struct.unpack("<II", f.read(8))
    print(f"FIXED: {path}  cert ({va}+{csize}>{size}) -> zeroed, verify va={va2} size={cs2}")

for p in sys.argv[1:]:
    fix(p)
