Live responses from the nightjet.com booking API, captured in a browser on
2026-10-01 (the dev sandbox cannot reach the host):

- `partner-2026-10-01.json` — `GET /nj-booking-ocp/destinations/partner/2026-10-01`
- `country-54-81-2026-10-01.json` — `GET /nj-booking-ocp/destinations/country/54/country/81/2026-10-01`

They settle three things `scripts/adapters/nightjet.mjs` relies on: an entry's
`date` is the train's next run (EN 40465 is listed for 15 October in the answer
for 1 October); a station carries its UIC `country` code; and a country pair
lists every train calling in the first country and later in the second, partner
trains included — 54 (Czechia) → 81 (Austria) answers with Przemyśl → München
and Berlin → Graz. Read by `tests/verify-nightjet-discovery.mjs`.
