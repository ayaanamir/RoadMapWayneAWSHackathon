// Who fixes the road at a pothole: the city, or the state (MDOT).
//
// In Detroit most streets belong to the city (Department of Public Works, reports go
// through Improve Detroit). State routes and freeways belong to MDOT, so a report sent
// to the city for those gets passed on or lost.
//
// This is a demo: we pick the owner from the street name with a short list of state
// routes in and around our area. A real version would look the spot up in Michigan's
// road ownership data (the Act 51 road map) instead of matching names.

const AGENCIES = {
  city: {
    name: 'City of Detroit, Public Works',
    short: 'City of Detroit',
    via: 'Improve Detroit',
  },
  state: {
    name: 'Michigan Department of Transportation (MDOT), Metro Region',
    short: 'MDOT',
    via: 'MDOT road concern form',
  },
};

// Street name pattern, and the state route it is part of.
const STATE_ROUTES = [
  [/\bmichigan ave/i, 'US-12'],
  [/\bwoodward ave/i, 'M-1'],
  [/\bgrand river ave/i, 'M-5'],
  [/\bgratiot ave/i, 'M-3'],
  [/\bfort st/i, 'M-85'],
  [/\bvan dyke/i, 'M-53'],
  [/\b(john c\.? )?lodge\b/i, 'M-10'],
  [/\bedsel ford (fwy|freeway)/i, 'I-94'],
  [/\b(fisher|chrysler) (fwy|freeway)/i, 'I-75'],
  [/\bjeffries (fwy|freeway)/i, 'I-96'],
  [/\bsouthfield (fwy|freeway)/i, 'M-39'],
  [/\bdavison (fwy|freeway)/i, 'M-8'],
];

// Returns { key, agency, route, kind, reason }. `kind` is a short phrase for the map
// ("State route US-12"), `reason` one plain sentence for the report.
function roadOwner(address) {
  const street = String(address || '').replace(/^[\d-]+\s+/, ''); // drop the house number
  for (const [pattern, route] of STATE_ROUTES) {
    const match = street.match(pattern);
    if (!match) continue;
    const where = street.includes('&') ? `This corner is on ${route}` : `${titleCase(match[0])} is ${route}`;
    return { key: 'state', agency: AGENCIES.state, route, kind: `State route ${route}`, reason: `${where}, a state route.` };
  }
  return {
    key: 'city',
    agency: AGENCIES.city,
    route: null,
    kind: 'City street',
    reason: street ? `${street} is a city street.` : 'Most Detroit streets are city streets.',
  };
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
