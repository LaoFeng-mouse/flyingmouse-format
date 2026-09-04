# Scan a tree of PE files for dangling certificate tables (CERT data directory VA+Size > file size).
# Root cause of store 0x800700C1 (see skill appx-msix-packaging). Usage: python scan_dangling.py <dir> [dir2...]
import sys, os, struct

def scan_file(path):
    """Return None if fine / not PE; else a tuple (cert_va, cert_size, file_size)."""
    try:
        size = os.path.getsize(path)
        if size < 0x40:
            return None
        with open(path, "rb") as f:
            if f.read(2) != b"MZ":
                return None
            f.seek(0x3C)
            e_lfanew = struct.unpack("<I", f.read(4))[0]
            if e_lfanew + 24 > size:
                return None
            f.seek(e_lfanew)
            if f.read(4) != b"PE\x00\x00":
                return None
            coff = f.read(20)
            n_sections = struct.unpack("<H", coff[2:4])[0]
            opt_size = struct.unpack("<H", coff[16:18])[0]
            magic = struct.unpack("<H", f.read(2))[0]
            # DataDirectory 在 optional header 内起始：PE32=96, PE32+=112；
            # certificate 是 index 4，每项 8 字节（VA + Size）。
            if magic == 0x10B:
                cert_off = e_lfanew + 24 + 96 + 4 * 8
            elif magic == 0x20B:
                cert_off = e_lfanew + 24 + 112 + 4 * 8
            else:
                return None
            if cert_off + 8 > size:
                return None
            f.seek(cert_off)
            va, csize = struct.unpack("<II", f.read(8))
            if csize == 0:
                return None
            if va + csize > size:
                return (va, csize, size)
            return None
    except OSError:
        return None

def main():
    total_bad = 0
    for root_dir in sys.argv[1:]:
        for base, _dirs, files in os.walk(root_dir):
            for name in files:
                if not name.lower().endswith((".exe", ".dll", ".sys", ".ocx")):
                    continue
                p = os.path.join(base, name)
                hit = scan_file(p)
                if hit:
                    total_bad += 1
                    va, cs, fs = hit
                    print(f"DANGLING: {p} certVA={va} certSize={cs} fileSize={fs} (overrun {va+cs-fs}B)")
    print(f"\nscan done: {total_bad} dangling-PE file(s)")
    sys.exit(1 if total_bad else 0)

main()
