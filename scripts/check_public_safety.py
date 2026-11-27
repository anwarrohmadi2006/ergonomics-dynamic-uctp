"""
Automated Public-Release Safety, Privacy, and Repository Hygiene Scanner for `lampiran/`.
Uses generic regex detectors (no hardcoded PII/secrets) plus optional local-only blocklists
stored outside `lampiran/` to enforce zero leakage of:
  - Original institutional lecturer names (loaded from `../experiments/fst-20261.json` if present)
  - Optional local sensitive tokens (`../.local_privacy_blocklist.txt`, never committed)
  - Student ID patterns, personal webmail addresses, hardcoded UUIDs, private Worker URLs
  - Forbidden raw binary extensions (.xlsx, .m4a, .env, etc.)
  - Unicode emojis
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

LAMPIRAN = Path(__file__).resolve().parent.parent
ROOT = LAMPIRAN.parent
RAW_DATASET = ROOT / "experiments" / "fst-20261.json"
LOCAL_BLOCKLIST = ROOT / ".local_privacy_blocklist.txt"

FORBIDDEN_EXTS = {".xlsx", ".xls", ".m4a", ".wav", ".mp3", ".env"}

REGEX_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("STUDENT_ID_PATTERN", re.compile(r"\b2474\d{5}\b")),
    (
        "HARDCODED_UUID",
        re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I),
    ),
    (
        "PERSONAL_WEBMAIL",
        re.compile(r"\b[A-Za-z0-9._%+-]+@(?:gmail|yahoo|outlook|hotmail)\.com\b", re.I),
    ),
    (
        "PHONE_NUMBER_ID",
        re.compile(r"\+62\s*8\d{2}[-.\s]?\d{3,4}[-.\s]?\d{3,5}"),
    ),
    (
        "PRIVATE_WORKER_URL",
        re.compile(r"\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b", re.I),
    ),
    (
        "RAW_INTERVIEW_OR_FORUM",
        re.compile(
            r"\b(?:" + "Wawan" + "cara_|" + "Trans" + r"krip\.txt|" + "r/" + "college|" + "red" + r"dit\.com)\b",
            re.I,
        ),
    ),
]

EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U0001F1E6-\U0001F1FF"
    "]",
    flags=re.UNICODE,
)


def load_raw_lecturers() -> list[str]:
    if not RAW_DATASET.exists():
        return []
    data = json.loads(RAW_DATASET.read_text(encoding="utf-8"))
    return sorted({s.get("dosen", "").strip() for s in data.get("sessions", []) if s.get("dosen", "").strip()})


def load_local_blocklist() -> list[str]:
    if not LOCAL_BLOCKLIST.exists():
        return []
    return [
        line.strip()
        for line in LOCAL_BLOCKLIST.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def main() -> None:
    lecturer_names = load_raw_lecturers()
    local_tokens = load_local_blocklist()
    violations: list[str] = []
    scanned_files = 0

    for f in sorted(LAMPIRAN.rglob("*")):
        if not f.is_file():
            continue
        if "node_modules" in f.parts or "__pycache__" in f.parts or ".git" in f.parts:
            continue
        scanned_files += 1
        rel = f.relative_to(LAMPIRAN)

        if f.suffix.lower() in FORBIDDEN_EXTS:
            violations.append(f"[FORBIDDEN_EXT] {rel}")
            continue

        try:
            text = f.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue

        for rule_name, pattern in REGEX_RULES:
            for m in pattern.finditer(text):
                # Allow placeholder UUIDs like 00000000-...
                if rule_name == "HARDCODED_UUID" and set(m.group(0).replace("-", "")) <= {"0"}:
                    continue
                violations.append(f"[{rule_name}:{m.group(0)}] in {rel}")

        for tok in local_tokens:
            if tok.lower() in text.lower():
                violations.append(f"[LOCAL_BLOCKLIST_MATCH] in {rel}")

        for name in lecturer_names:
            if name in text:
                violations.append(f"[PII_LECTURER] in {rel}")

        if EMOJI_RE.search(text):
            violations.append(f"[EMOJI_DETECTED] in {rel}")

    if violations:
        print(f"FAIL: {len(violations)} public-safety violation(s) found across {scanned_files} files:")
        for v in violations[:50]:
            print("  -", v)
        sys.exit(1)

    print(
        f"PASS: 0 privacy/secret/emoji violations across {scanned_files} files in lampiran/ "
        f"(self-inclusive scan; {len(lecturer_names)} lecturer names, {len(REGEX_RULES)} regex rules, "
        f"{len(local_tokens)} local blocklist tokens)."
    )


if __name__ == "__main__":
    main()
