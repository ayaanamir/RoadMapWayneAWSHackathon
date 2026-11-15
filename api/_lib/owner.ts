// Who fixes the road at a pothole: the city, or the state (MDOT).
//
// Same rules as apps/map/agency.js, done once here so every page (map, phone drive
// report, pipeline drive report) gives the same "report it to" answer.
//
// In Detroit most streets belong to the city (Public Works, reports through Improve
// Detroit). State routes and freeways belong to MDOT. We pick the owner from the street
// name with a short list of state routes. A real version would look the spot up in
// Michigan's road ownership data (the Act 51 map), and would also know Wayne County
// roads and the other cities (Dearborn, Hamtramck, Highland Park).

export type Owner = {
  key: 'city' | 'state';
  agency: string; // full name
  short: string; // for buttons and tight spaces
  via: string; // where the report goes
  route: string | null; // state route number, e.g. "M-1"
  reason: string; // one plain sentence
};

const AGENCIES = {
  city: { agency: 'City of Detroit, Public Works', short: 'City of Detroit', via: 'Improve Detroit' },
  state: {
    agency: 'Michigan Department of Transportation (MDOT), Metro Region',
    short: 'MDOT',
    via: 'MDOT road concern form',
  },
};

// Street name pattern, and the state route it is part of.
const STATE_ROUTES: [RegExp, string][] = [
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

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function roadOwner(address: string | null | undefined): Owner {
  const street = String(address || '').replace(/^[\d-]+\s+/, ''); // drop the house number
  for (const [pattern, route] of STATE_ROUTES) {
    const match = street.match(pattern);
    if (!match) continue;
    const where = street.includes('&') ? `This corner is on ${route}` : `${titleCase(match[0])} is ${route}`;
    return { key: 'state', ...AGENCIES.state, route, reason: `${where}, a state route.` };
  }
  return {
    key: 'city',
    ...AGENCIES.city,
    route: null,
    reason: street ? `${street} is a city street.` : 'Most Detroit streets are city streets.',
  };
}
