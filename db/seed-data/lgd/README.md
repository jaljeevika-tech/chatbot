# LGD (Local Government Directory) seed data

Reference data for the State → District → Block → Panchayat → Village
dropdowns on the "+ New Project" form (`src/components/dashboard/NewProjectModal.tsx`),
using the Government of India's official LGD administrative codes.

## Source

March 11, 2022 snapshot of https://lgdirectory.gov.in, mirrored at
[planemad/india-local-government-directory](https://github.com/planemad/india-local-government-directory)
under the [Government Open Data License – India](https://data.gov.in/sites/default/files/Gazette_Notification_OGDL.pdf).
The official LGD portal has no public bulk-download API (it's a
session/CSRF-protected web app), so this community mirror is the only
practical nationwide source. **These codes/names are a 2022 snapshot** —
LGD does get updated (new districts split off, blocks renamed, etc.), so
expect minor drift from the live directory. Re-download from the source
repo above to refresh.

## Files (gzipped CSVs, ~14MB total)

| File | Source path in mirror repo | Rows | Contents |
|---|---|---|---|
| `states.csv.gz` | `administrative/1-state.csv` | 36 | All states/UTs |
| `districts.csv.gz` | `administrative/2-district.csv` | 763 | Districts, with parent state code |
| `blocks.csv.gz` | `administrative/blocks.csv` | 7,232 | Administrative Blocks, with parent district+state code |
| `rural-local-body.csv.gz` | `municipal/rural-local-body.csv` | 263,027 | All 3 PRI tiers (District/Intermediate/Village Panchayat) — only `Local Body Type Code = 3` (Village Panchayat, 255,347 rows) is imported, as the "Panchayat" dropdown level |
| `village-directory.csv.gz` | `village-directory.csv.zip` (repo root) | 689,682 | Every village, with its State/District/Sub-district/Block code+name and Panchayat ("Localbody") code — this is what drives the Village dropdown and also supplies the Block↔Panchayat link (see note below) |

## Important: Block and Panchayat are two different LGD code namespaces

LGD assigns "Block" (`administrative/blocks.csv`, the revenue/administrative
Community Development block) and "Intermediate Panchayat" (one tier inside
`rural-local-body.csv`, the elected local-body covering the same area) to
**separate code series**, even though they usually describe the same
geography. There's no direct Block-code ↔ Intermediate-Panchayat-code
mapping column in the source data.

So `scripts/import-lgd-data.js` links a Panchayat to a Block empirically:
for each Panchayat (`Localbody Code` in `rural-local-body.csv`, type 3),
it looks at the villages in `village-directory.csv` that report that
Panchayat and takes the most common `Block code` among them. This is
reliable because it's the same Block code the Village dropdown itself
uses — the cascade stays internally consistent even where LGD's own
cross-references don't line up.

## Re-seeding

```bash
node scripts/import-lgd-data.js
```

Safe to re-run — every insert is `ON CONFLICT (code) DO UPDATE`.
