-- Neon project: still-there-builderwars. Already applied — this file documents it.
-- Change only through the Backbone owner (and bump shared/CONTRACTS.md if shapes change).

CREATE TABLE potholes (
  pothole_id   text PRIMARY KEY,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  address      text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT 'unknown'
               CHECK (state IN ('still_there','fixed_confirmed','reported_only','unreported','unknown')),
  last_seen_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE city_reports (
  issue_id   text PRIMARY KEY,
  address    text NOT NULL DEFAULT '',
  lat        double precision NOT NULL,
  lon        double precision NOT NULL,
  status     text NOT NULL CHECK (status IN ('Open','Closed','Archived')),
  created_at timestamptz NOT NULL,
  closed_at  timestamptz,
  issue_url  text NOT NULL,
  photo_url  text,
  pothole_id text
);

CREATE TABLE detections (
  detection_id   text PRIMARY KEY,
  source         text NOT NULL CHECK (source IN ('live','drive')),
  lat            double precision NOT NULL,
  lon            double precision NOT NULL,
  captured_at    timestamptz NOT NULL,
  confidence     real NOT NULL,
  bbox           jsonb,
  image_url      text NOT NULL,
  verdict        text NOT NULL DEFAULT 'unverified'
                 CHECK (verdict IN ('pothole','shadow','patch','unverified')),
  verdict_reason text,
  pothole_id     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX city_reports_pothole_idx ON city_reports (pothole_id);
CREATE INDEX detections_pothole_idx   ON detections (pothole_id);

-- Seeded: 3 potholes (Peterboro, Newark, Wabash) + their 6 real city reports.
-- lat/lon are placeholders — the ingest script overwrites them with the city geocode.

-- ---------------------------------------------------------------------------
-- Added for #12/#56. The ONE place the contract's state rule lives
-- (shared/CONTRACTS.md v3). Called by POST /api/detections and ingest_city.py.
--   still_there     latest city report Closed/Archived, and the latest *verified*
--                   (pothole|patch) detection after its closed_at is `pothole`
--   fixed_confirmed same, but that latest verified detection is `patch`
--   reported_only   city reports, no detections
--   unreported      no city reports, and >=1 `pothole` verdict or >=2 detections
--   unknown         anything else (open report, only unverified/shadow after close, ...)
-- last_seen_at = newest detection that isn't shadow/patch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_pothole(p text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n_reports    int;
  n_pothole    int;
  n_unverified int;
  n_dets       int;
  last_status  text;
  last_closed  timestamptz;
  verdict_now  text;
  new_state    text;
BEGIN
  SELECT count(*) INTO n_reports FROM city_reports WHERE pothole_id = p;
  SELECT count(*), count(*) FILTER (WHERE verdict = 'pothole'), count(*) FILTER (WHERE verdict = 'unverified')
    INTO n_dets, n_pothole, n_unverified FROM detections WHERE pothole_id = p;

  IF n_reports = 0 THEN
    -- Only positive evidence counts: shadow/patch verdicts are the vision check saying 'not a pothole'.
    IF n_pothole >= 1 OR n_unverified >= 2 THEN
      new_state := 'unreported';
    ELSE
      -- No city report and nothing positive left: per the contract matching rule this is not a
      -- pothole. Keep the sightings (pothole_id = null, not shown) and drop the pin.
      UPDATE detections SET pothole_id = NULL WHERE pothole_id = p;
      DELETE FROM potholes WHERE pothole_id = p;
      RETURN 'removed';
    END IF;
  ELSIF n_dets = 0 THEN
    new_state := 'reported_only';
  ELSE
    SELECT status, closed_at INTO last_status, last_closed
      FROM city_reports WHERE pothole_id = p ORDER BY created_at DESC LIMIT 1;
    IF last_status IN ('Closed', 'Archived') AND last_closed IS NOT NULL THEN
      SELECT verdict INTO verdict_now FROM detections
       WHERE pothole_id = p AND captured_at > last_closed AND verdict IN ('pothole', 'patch')
       ORDER BY captured_at DESC LIMIT 1;
      new_state := CASE verdict_now WHEN 'pothole' THEN 'still_there'
                                    WHEN 'patch'   THEN 'fixed_confirmed'
                                    ELSE 'unknown' END;
    ELSE
      new_state := 'unknown';
    END IF;
  END IF;

  UPDATE potholes
     SET state = new_state,
         last_seen_at = (SELECT max(captured_at) FROM detections
                          WHERE pothole_id = p AND verdict IN ('pothole', 'unverified')),
         updated_at = now()
   WHERE pothole_id = p;
  RETURN new_state;
END $$;

-- Nearest-pothole lookups (bbox prefilter before the haversine).
CREATE INDEX IF NOT EXISTS potholes_lat_lon_idx   ON potholes (lat, lon);
CREATE INDEX IF NOT EXISTS detections_lat_lon_idx ON detections (lat, lon);

-- ---------------------------------------------------------------------------
-- Added for #7. Groups city reports into potholes with the 50 m rule.
-- Called by ingest_city.py after it upserts city_reports. Safe to re-run:
-- reports that already have a pothole_id keep it.
--   1. potholes with no detections move to the mean of their reports' city geocode
--      (fixes the seeded placeholders; never moves a pothole our camera has seen)
--   2. each unassigned report (oldest first) joins the nearest pothole <= 50 m,
--      else starts a new pothole  ph_<issue_id>  at its own location
--   3. step 1 again, then recompute state for every pothole that has reports
-- Returns the number of potholes created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION group_city_reports() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  r       record;
  target  text;
  created int := 0;
BEGIN
  -- reports pointing at a pothole that no longer exists get regrouped
  UPDATE city_reports c SET pothole_id = NULL
   WHERE c.pothole_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM potholes p WHERE p.pothole_id = c.pothole_id);

  UPDATE potholes p SET lat = c.lat, lon = c.lon, updated_at = now()
    FROM (SELECT pothole_id, avg(lat) AS lat, avg(lon) AS lon FROM city_reports
           WHERE pothole_id IS NOT NULL GROUP BY pothole_id) c
   WHERE p.pothole_id = c.pothole_id
     AND NOT EXISTS (SELECT 1 FROM detections d WHERE d.pothole_id = p.pothole_id);

  FOR r IN SELECT issue_id, lat, lon, address FROM city_reports
            WHERE pothole_id IS NULL ORDER BY created_at LOOP
    SELECT p.pothole_id INTO target FROM potholes p
     WHERE abs(p.lat - r.lat) < 0.001 AND abs(p.lon - r.lon) < 0.001
       AND 6371000 * 2 * asin(sqrt(power(sin(radians(p.lat - r.lat) / 2), 2) +
           cos(radians(r.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lon - r.lon) / 2), 2))) <= 50
     ORDER BY 6371000 * 2 * asin(sqrt(power(sin(radians(p.lat - r.lat) / 2), 2) +
           cos(radians(r.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lon - r.lon) / 2), 2)))
     LIMIT 1;
    IF target IS NULL THEN
      target := 'ph_' || r.issue_id;
      INSERT INTO potholes (pothole_id, lat, lon, address)
      VALUES (target, r.lat, r.lon, r.address) ON CONFLICT (pothole_id) DO NOTHING;
      created := created + 1;
    END IF;
    UPDATE city_reports SET pothole_id = target WHERE issue_id = r.issue_id;
  END LOOP;

  UPDATE potholes p SET lat = c.lat, lon = c.lon, updated_at = now()
    FROM (SELECT pothole_id, avg(lat) AS lat, avg(lon) AS lon FROM city_reports
           WHERE pothole_id IS NOT NULL GROUP BY pothole_id) c
   WHERE p.pothole_id = c.pothole_id
     AND NOT EXISTS (SELECT 1 FROM detections d WHERE d.pothole_id = p.pothole_id);

  PERFORM recompute_pothole(pothole_id) FROM (SELECT DISTINCT pothole_id FROM city_reports
                                               WHERE pothole_id IS NOT NULL) s;
  RETURN created;
END $$;

-- ---------------------------------------------------------------------------
-- Added for model training (internal, not in shared/CONTRACTS.md): team review of
-- teacher-labelled dash-cam frames. Served by api/labels.ts, reviewed at /label.
-- Boxes are normalised {x,y,w,h} with a top-left origin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS label_frames (
  frame_id      text PRIMARY KEY,                -- crowd_<videoid>_<t_ms> (= R2 frames/<id>.jpg)
  image_url     text NOT NULL,
  split         text NOT NULL DEFAULT 'train' CHECK (split IN ('train','test')),
  video_id      text NOT NULL DEFAULT '',
  t_sec         real,
  teacher       jsonb,                           -- {potholes:[…], lookalikes:[…], road_visible}
  teacher_model text,
  teacher_error text,
  boxes         jsonb,                           -- human-reviewed potholes; [] = no pothole
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','taught','reviewed','skipped')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_ms     integer,
  lock_by       text,                            -- reviewer (or '_teacher') holding the frame
  lock_until    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Added for the vision-check retry: how many times the server tried to check this sighting.
ALTER TABLE detections ADD COLUMN IF NOT EXISTS verify_attempts integer NOT NULL DEFAULT 0;
