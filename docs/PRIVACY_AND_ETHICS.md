# Privacy, Anonymization, and Stakeholder Protocol

## 1. Dataset Anonymization

- All 45 real lecturer names in the original Faculty of Science and Technology (FST) Odd 2026/2027 operational workbook have been deterministically mapped to pseudonymous identifiers (`LECTURER_01` through `LECTURER_45`) in `data/fst-20261-anonymized.json`.
- Audit parity between the original institutional workbook and the anonymized JSON is verified bit-for-bit via `CSPEngine.auditSchedule` (`rawHumaneScore = 42.4`, `280` scheduled weekly sessions, `36` atomic classes, `45` lecturers).
- No raw spreadsheets (`.xlsx`), audio recordings (`.m4a`), verbatim transcripts, student identification numbers, personal email addresses, or private infrastructure identifiers are present in this repository.

## 2. Stakeholder Elicitation Protocol

Constraint elicitation and workflow requirements were collected through a semi-structured interview with the faculty scheduling administrator (`n = 1`, academic scheduling officer responsible for timetable operations across all five FST departments) conducted on **20 November 2026**.

- **Protocol Scope:** Identification of hard operational rules (Monday-Wednesday borrowed Postgraduate room restrictions, semester `s+2` wet-lab assistant pairing, fixed doctoral-study lecturer slots, SIAKAD V2 boolean export schema, and mid-semester manual revision bottlenecks).
- **Ethics and Consent:** Participation was voluntary with informed consent for academic reporting; the administrator's name and personal voice recordings are withheld and anonymized.
- **Policy Status Disclosure:**
  - The manual baseline represents an **initial published operational timetable** that exhibited residual hard clashes and borrowed-room violations prior to automated validation.
  - Using two computing laboratories (`LAB. DATA ENGINEER` and `LAB. DATA SCIENCE`) for Informatics and Data Science theory overflow is evaluated explicitly as a **policy recommendation scenario** (Mode B) alongside the strict 47-room-day current-policy baseline (Mode A), pending formal faculty approval.

## 3. Automated Release Verification

Before any commit or tag, run:

```bash
python scripts/check_public_safety.py
```

The scanner enforces zero leakage of the 45 original lecturer names, student IDs, private Cloudflare database IDs, personal subdomains, informal references, forbidden raw binary extensions, and Unicode emojis.
