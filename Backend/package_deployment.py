"""Build the allowlisted Elastic Beanstalk source bundle."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
files = [root / "Procfile", root / "requirements.txt"]
files += sorted((root / "app").rglob("*.py"))
files += sorted((root / ".platform").rglob("*.conf"))
files += sorted((root / "deploy").glob("*.service"))
certificate = root / "certs" / "supabase-ca.crt"
if not certificate.is_file():
    raise SystemExit("Supabase CA certificate is required for production")
files.append(certificate)

output = root / "dist" / "tibbou-api.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as bundle:
    for file in files:
        bundle.write(file, file.relative_to(root).as_posix())
print(f"Built {output} with {len(files)} allowlisted files")
