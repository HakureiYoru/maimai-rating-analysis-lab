import csv
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
UUID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
HTTP_PATTERN = re.compile(r"https?://", re.IGNORECASE)

EXPECTED_HEADERS = {
    "comments.csv": ["Owner", "workNumber", "score", "replyTo", "comment"],
    "work-submissions.csv": [
        "作品Title/曲名",
        "Video /BGA      (optional)",
        "sequenceId",
        "bg",
        "不要在designer栏位填写自己的真实ID！/ Do not put your real ID in the designer field ！",
        "Owner",
        "isDQ",
    ],
    "competition-registrations.csv": ["您的ID", "Owner", "isHighQuality"],
}


def fail(message: str) -> None:
    print(f"PUBLIC DATA CHECK FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


for file_name, expected_headers in EXPECTED_HEADERS.items():
    file_path = DATA_DIR / file_name
    if not file_path.is_file():
        fail(f"missing {file_path.relative_to(ROOT)}")

    text = file_path.read_text(encoding="utf-8-sig")
    if UUID_PATTERN.search(text):
        fail(f"UUID found in data/{file_name}")
    if HTTP_PATTERN.search(text):
        fail(f"HTTP link found in data/{file_name}")

    with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != expected_headers:
            fail(
                f"unexpected columns in data/{file_name}: "
                f"{reader.fieldnames!r}; expected {expected_headers!r}"
            )
        rows = list(reader)

    if not rows:
        fail(f"data/{file_name} has no rows")

print("Public data check passed.")
