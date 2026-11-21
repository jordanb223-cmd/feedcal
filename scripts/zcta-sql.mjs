// Turns parsed ZCTA rows into SQL batches for public.zip_codes (D34). Values are checked by
// parseGazetteer (5 digits; numeric lat/lon in range) and re-checked here before going into SQL.
export function zctaSqlBatches(rows, size = 2000) {
  const batches = [];
  for (let i = 0; i < rows.length; i += size) {
    const values = rows.slice(i, i + size).map(({ zip, location }) => {
      const m = /^SRID=4326;POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(location);
      if (!/^\d{5}$/.test(zip) || !m) throw new Error(`Unexpected row: ${zip}`);
      return `('${zip}', extensions.st_geogfromtext('SRID=4326;POINT(${m[1]} ${m[2]})'))`;
    });
    batches.push(`insert into public.zip_codes (zip, location) values ${values.join(",")} on conflict (zip) do update set location = excluded.location;`);
  }
  return batches;
}

// After loading: give existing feeds with a ZIP their map point (the trigger only runs on change).
export const AFTER_LOAD_SQL = "update public.feeds f set location = z.location from public.zip_codes z where z.zip = f.zip_code and f.location is null;";
