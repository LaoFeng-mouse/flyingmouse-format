# Rename OPC reserved names inside the appx layout copy (MakeAppx rejects *.rels / [Content_Types].xml).
# Operates ONLY on the given tree (never the bin/ source). Prints each rename.
import sys, os

root = sys.argv[1]
count = 0
for base, dirs, files in os.walk(root, topdown=False):
    for name in files:
        lower = name.lower()
        target = None
        if lower.endswith(".rels"):
            target = os.path.join(base, name + ".txt")
        elif lower == "[content_types].xml":
            target = os.path.join(base, name + ".txt")
        if target:
            os.rename(os.path.join(base, name), target)
            count += 1
print("renamed", count, "OPC-reserved file(s)")

bad = 0
for base, dirs, files in os.walk(root):
    for name in files:
        if name.lower().endswith(".rels") or name.lower() == "[content_types].xml":
            bad += 1
            print("  STILL RESERVED:", os.path.join(base, name))
print("remaining reserved:", bad)
sys.exit(1 if bad else 0)
