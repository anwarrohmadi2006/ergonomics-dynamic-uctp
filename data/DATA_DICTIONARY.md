# Data Dictionary — `fst-20261-anonymized.json`

Dataset institusional Fakultas Sains dan Teknologi (FST) Semester Ganjil 2026/2027 yang telah dianonimisasi untuk keperluan reproduktifitas publik.

## Skala Ringkas
- **Total baris mentah:** 292 (`280` sesi terjadwal mingguan aktif + `12` entri non-terjadwal seperti skripsi, PKL, dan proyek mandiri)
- **Program studi (5):** `BTK` (Bioteknologi), `IL` (Ilmu Lingkungan), `IF` (Informatika), `SD` (Sains Data), `TP` (Teknologi Pangan)
- **Kelas atomik:** 36 kelas (melalui ekspansi sub-kelompok praktikum terhadap kelas induk)
- **Dosen:** 45 pengajar unik yang dianonimisasi secara deterministik menjadi `LECTURER_01` s.d. `LECTURER_45`
- **Ruangan aktif:** 25 ruangan (`9` ruang pinjaman Pascasarjana Senin–Rabu, `4` ruang umum FST Senin–Jumat, `12` laboratorium aktif — `8` lab basah terpakai + lab kering/khusus)

## Struktur JSON

### 1. `meta`
| Field | Tipe | Deskripsi |
|---|---|---|
| `sourceFile` | `string` | Nama berkas teranonimisasi (`fst-20261-anonymized.json`) |
| `semester` | `string` | `Ganjil 2026/2027` |
| `faculty` | `string` | `Fakultas Sains dan Teknologi (FST)` |
| `totalRows` | `number` | `292` |
| `scheduledCount` | `number` | `280` |
| `nonScheduledCount` | `number` | `12` |
| `anonymized` | `boolean` | `true` |
| `uniqueAnonymizedLecturers` | `number` | `45` |

### 2. `rooms[]`
| Field | Tipe | Deskripsi |
|---|---|---|
| `name` | `string` | Pengenal ruang ternormalisasi (mis. `Pasca A-201`, `LAB. 4-01`, `LAB. KIMIA`) |
| `type` | `enum` | `PASCA` \| `SAINTEK` \| `WET_LAB` \| `DRY_LAB` \| `OTHER_LAB` |
| `allowedDays` | `string[]` | Hari operasional ruang (`Senin`–`Rabu` untuk `PASCA`, `Senin`–`Jumat` untuk lainnya) |
| `activeInBaseline` | `boolean` | Apakah digunakan pada jadwal baseline manual |
| `baselineSessions` | `number` | Jumlah sesi baseline pada ruang tersebut |

### 3. `sessions[]` (280 Sesi Aktif)
| Field | Tipe | Deskripsi |
|---|---|---|
| `id` | `string` | ID sesi deterministik (`S001`–`S280`) |
| `prodi` / `prodiName` | `string` | Kode dan nama program studi |
| `kodeJadwal` / `kodeMk` | `string` | Kode jadwal dan kode mata kuliah |
| `namaMk` | `string` | Nama mata kuliah / praktikum |
| `sks` | `number` | Beban SKS |
| `kelasRaw` / `classes` | `string` / `string[]` | Kelas gabungan yang sudah dipisah dan dinormalisasi |
| `semester` | `number \| null` | Tingkat semester (`1`, `3`, `5`, `7`) untuk pencocokan Asprak `s+2` |
| `dosen` | `string` | ID dosen anonim (`LECTURER_01`–`LECTURER_45`) atau kosong untuk praktikum tim |
| `day` | `string` | Hari baseline (`Senin`..`Jumat`) |
| `start` / `end` / `duration` | `number` | Menit sejak `00:00` (mis. `520` = `08:40`, `720` = `12:00`, `780` = `13:00`) |
| `room` / `roomType` | `string` | Ruang penempatan baseline dan tipenya |
| `isPraktikum` / `isWetLab` | `boolean` | Penanda sesi praktikum dan kebutuhan Asprak lab basah |
| `isExamEligible` | `boolean` | Kelayakan penjadwalan ujian tulis UAS |
| `pinned` / `pinReason` | `boolean` / `string` | Penanda reservasi tetap (mis. studi S3 dosen) |
