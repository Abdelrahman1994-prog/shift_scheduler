// Fixed-date Egyptian national holidays — same Gregorian date every year,
// so these can be seeded automatically and safely.
//
// Deliberately NOT included: Eid al-Fitr, Eid al-Adha, Islamic New Year,
// Prophet's Birthday (Mawlid), and Sham El Nessim. Their Gregorian date
// shifts every year (lunar calendar / moon sighting, or movable feast) and
// is only confirmed by the government shortly before it happens — hardcoding
// a guessed date here would risk silently blocking or allowing scheduling on
// the wrong day. Add those from Settings → Public holidays once announced.
const FIXED_HOLIDAYS = [
  { month: 1, day: 7, name: 'Coptic Christmas' },
  { month: 1, day: 25, name: 'Revolution Day (Police Day)' },
  { month: 4, day: 25, name: 'Sinai Liberation Day' },
  { month: 5, day: 1, name: 'Labour Day' },
  { month: 6, day: 30, name: 'June 30 Revolution' },
  { month: 7, day: 23, name: '23 July Revolution' },
  { month: 10, day: 6, name: 'Armed Forces Day' }
];

function fixedHolidaysForYear(year) {
  return FIXED_HOLIDAYS.map((h) => ({
    date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`,
    name: h.name
  }));
}

module.exports = { FIXED_HOLIDAYS, fixedHolidaysForYear };
