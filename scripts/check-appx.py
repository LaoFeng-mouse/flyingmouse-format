# Post-pack verification for the appx deliverable:
#  1) zip integrity (testzip == None)
#  2) root entries: [Content_Types].xml, AppxManifest.xml, AppxBlockMap.xml present; AppxSignature.p7x ABSENT (= unsigned, store re-signs)
#  3) manifest Identity/Publisher/Version correct
#  4) app/resources/app.asar inside package == dist/win-unpacked asar (SHA-256, streamed)
# Usage: python check-appx.py <pkg.appx> <expected-asar-path>
import sys, zipfile, hashlib, re

pkg, asar_ref = sys.argv[1], sys.argv[2]

with zipfile.ZipFile(pkg) as z:
    bad = z.testzip()
    names = z.namelist()
    print("zip integrity:", "OK" if bad is None else f"BAD at {bad}")
    roots = {n for n in names if "/" not in n.rstrip("/") and n not in ("", "/")}
    top = [n for n in names if n.count("/") == 0]
    for needed in ("[Content_Types].xml", "AppxManifest.xml", "AppxBlockMap.xml"):
        print(f"{needed}:", "present" if needed in top else "MISSING")
    print("AppxSignature.p7x:", "ABSENT (unsigned, good for store)" if "AppxSignature.p7x" not in top else "present(!)")

    with z.open("AppxManifest.xml") as f:
        manifest = f.read().decode("utf-8")
    ident = re.search(r'<Identity Name="([^"]+)"[^>]*Publisher=\'([^\']+)\'[^>]*Version="([^"]+)"', manifest)
    if ident:
        print("Identity:", ident.group(1), "| Publisher:", ident.group(2), "| Version:", ident.group(3))
    pub = re.search(r"<PublisherDisplayName>([^<]+)</PublisherDisplayName>", manifest)
    print("PublisherDisplayName:", pub.group(1) if pub else "?")

    # asar compare
    def sha_stream(zf, name):
        h = hashlib.sha256()
        with zf.open(name) as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    inner = None
    for n in names:
        if n.replace("\\", "/") == "app/resources/app.asar":
            inner = n
            break
    ref = hashlib.sha256(open(asar_ref, "rb").read()).hexdigest()
    if inner:
        got = sha_stream(z, inner)
        print("asar SHA in pkg :", got)
        print("asar SHA win-unp:", ref)
        print("ASAR MATCH:", "YES" if got == ref else "NO — FIX NOT PACKED!")
    else:
        print("app/resources/app.asar NOT FOUND in package")
        sys.exit(2)
print("size:", __import__("os").path.getsize(pkg), "bytes")
