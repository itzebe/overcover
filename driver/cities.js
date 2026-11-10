// Cities Overcover can write rainfall cover for, with coordinates and a
// human-readable reference point. Coordinates are fixed in the product, so a
// buyer cannot move the goalposts to a wetter location.
export const CITIES = {
  lagos:     { name: "Lagos",     lat: 6.5244,  lon: 3.3792,   note: "tropical, frequent convective rain" },
  singapore: { name: "Singapore", lat: 1.3521,  lon: 103.8198, note: "equatorial, very frequent rain" },
  mumbai:    { name: "Mumbai",    lat: 19.0760, lon: 72.8777,  note: "monsoon belt" },
  manila:    { name: "Manila",    lat: 14.5995, lon: 120.9842, note: "tropical" },
  bogota:    { name: "Bogotá",    lat: 4.7110,  lon: -74.0721, note: "Andean, frequent afternoon rain" },
  london:    { name: "London",    lat: 51.5074, lon: -0.1278,  note: "temperate, frequent light rain" },
  seattle:   { name: "Seattle",   lat: 47.6062, lon: -122.3321, note: "temperate, frequent drizzle" },
  bergen:    { name: "Bergen",    lat: 60.3913, lon: 5.3221,   note: "very wet" },
  miami:     { name: "Miami",     lat: 25.7617, lon: -80.1918, note: "subtropical squalls" },
  tokyo:     { name: "Tokyo",     lat: 35.6762, lon: 139.6503, note: "temperate, typhoon season" },
  jakarta:   { name: "Jakarta",   lat: -6.2088, lon: 106.8456, note: "tropical, very frequent rain" },
  kolkata:   { name: "Kolkata",   lat: 22.5726, lon: 88.3639,  note: "monsoon belt" },
};
