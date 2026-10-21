"""Package only distributable source and explicit public samples, never local data."""
from pathlib import Path
import hashlib
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT.parent/'deliverables'
OUT.mkdir(exist_ok=True)
EXCLUDED_DIRS={'.venv','.git','node_modules','dist','__pycache__','.pytest_cache','var','screenshots','test-results','runs'}

def included(path):
    relative=path.relative_to(ROOT)
    if any(part in EXCLUDED_DIRS for part in relative.parts): return False
    if path.name.startswith('.env') and path.name!='.env.example': return False
    if '.sqlite' in path.name or path.suffix in {'.pyc','.db'}: return False
    if path.suffix=='.log' and relative.as_posix()!='research/public-source-smoke/optical_http_trace.log': return False
    return path.is_file()

files=sorted(p for p in ROOT.rglob('*') if included(p) and p.name!='SOURCE_MANIFEST.sha256')
manifest=ROOT/'SOURCE_MANIFEST.sha256'
manifest.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(ROOT).as_posix()}\n' for p in files))
files.append(manifest)
archive=OUT/'fieldsignal-v0-20261015.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in files: z.write(p,Path('fieldsignal')/p.relative_to(ROOT))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(f'{archive}\nfiles={len(files)} bytes={archive.stat().st_size}\nsha256={digest}')
