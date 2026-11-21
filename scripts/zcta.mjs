// Parses the US Census ZCTA gazetteer (tab-separated; columns GEOID … INTPTLAT INTPTLONG) into
// rows for public.zip_codes. City and state aren't in this file; they stay empty (D34).
export function parseGazetteer(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = (lines.shift() ?? "").split("\t").map((h) => h.trim().toUpperCase());
  const iZip = header.indexOf("GEOID");
  const iLat = header.indexOf("INTPTLAT");
  const iLon = header.indexOf("INTPTLONG");
  if (iZip < 0 || iLat < 0 || iLon < 0) throw new Error("Not a ZCTA gazetteer file (need GEOID, INTPTLAT, INTPTLONG columns).");
  const rows = [];
  for (const line of lines) {
    const cols = line.split("\t").map((c) => c.trim());
    const zip = cols[iZip];
    const lat = Number(cols[iLat]);
    const lon = Number(cols[iLon]);
    if (!/^\d{5}$/.test(zip ?? "") || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    rows.push({ zip, location: `SRID=4326;POINT(${lon} ${lat})` });
  }
  return rows;
}
