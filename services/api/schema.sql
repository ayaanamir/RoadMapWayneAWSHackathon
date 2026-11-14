-- Neon project: still-there-builderwars. Already applied — this file documents it.
-- Change only through the Backbone owner (and bump shared/CONTRACTS.md if shapes change).

CREATE TABLE potholes (
  pothole_id   text PRIMARY KEY,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  address      text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT 'unknown'
               CHECK (state IN ('still_there','fixed_confirmed','reported_only','unknown')),
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
