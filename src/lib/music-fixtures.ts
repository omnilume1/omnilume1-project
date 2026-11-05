import type { MusicTrack } from './music-model';

// Synthetic catalogue for the Stage 1 shell: invented titles/artists, colour-only artwork, no audio.
export type MusicAlbum = { id: string; title: string; artist: string; year: number; hue: number; genre: string; tracks: MusicTrack[] };
export type MusicPlaylist = { id: string; title: string; description: string; hue: number; tracks: MusicTrack[] };

const ALBUM_SEEDS: [string, string, string, number, number, string, string[]][] = [
  ['glass-harbour', 'Glass Harbour', 'Lumen Arcade', 2025, 262, 'Synthpop', ['Low Tide Signal', 'Paper Satellites', 'Harbour Lights', 'Afterimage', 'Night Ferry', 'Salt & Static']],
  ['quiet-orbit', 'Quiet Orbit', 'Mira Vale', 2024, 200, 'Ambient', ['First Light', 'Slow Rotation', 'Weightless', 'Far Side', 'Return Burn']],
  ['paper-kites', 'Paper Kites', 'The Ninth Hour', 2023, 32, 'Indie', ['Kite Season', 'Rooftop Radio', 'Lost Postcards', 'Summer Static', 'Blue Hour', 'Long Way Round', 'Goodnight, City']],
  ['velvet-circuit', 'Velvet Circuit', 'Nova Reyes', 2026, 318, 'Electronic', ['Overclock', 'Velvet', 'Signal Bloom', 'Midnight Loop']],
  ['study-sessions', 'Study Sessions Vol. 1', 'Lo Fern', 2025, 140, 'Lo-fi', ['Notebook Margins', 'Rain on Glass', 'Library Hours', 'Tea Break', 'Footnotes', 'Late Chapter']],
  ['northern-wires', 'Northern Wires', 'Halden', 2022, 188, 'Folk', ['Telegraph Hill', 'Snowline', 'The Long Field', 'Ember Song']],
  ['solar-drift', 'Solar Drift', 'Mira Vale', 2026, 44, 'Ambient', ['Perihelion', 'Drift', 'Corona', 'Heliopause', 'Dawn Again']],
  ['city-of-echoes', 'City of Echoes', 'Lumen Arcade', 2023, 282, 'Synthpop', ['Echo Avenue', 'Neon Rain', 'Subway Hearts', 'Skyline Call', 'Last Train']],
];

export const MUSIC_ALBUMS: MusicAlbum[] = ALBUM_SEEDS.map(([id, title, artist, year, hue, genre, names], albumIndex) => ({
  id, title, artist, year, hue, genre,
  tracks: names.map((name, i) => ({
    id: `${id}-${i + 1}`,
    title: name,
    artist,
    album: title,
    albumId: id,
    hue: (hue + i * 9) % 360,
    durationMs: (150 + ((albumIndex * 37 + i * 53) % 120)) * 1000,
  })),
}));

const ALL = MUSIC_ALBUMS.flatMap((album) => album.tracks);
export const MUSIC_TRACKS: MusicTrack[] = ALL;

// One track with synced lines so the lyrics panel has something to show (our own words).
ALL[0].lyrics = [
  { ms: 0, text: 'Lights on the water, slow and low' },
  { ms: 6000, text: 'A signal only harbours know' },
  { ms: 12000, text: 'I send it out, it echoes back' },
  { ms: 18000, text: 'A paper boat on a silver track' },
  { ms: 26000, text: '(Low tide, low tide)' },
  { ms: 32000, text: 'Hold the line until the morning' },
  { ms: 40000, text: 'Hold the line, the tide is turning' },
];

const pick = (ids: string[]) => ids.map((id) => ALL.find((track) => track.id === id)).filter((track): track is MusicTrack => Boolean(track));

export const MUSIC_PLAYLISTS: MusicPlaylist[] = [
  { id: 'focus', title: 'Deep Focus', description: 'Calm, wordless tracks for long study blocks.', hue: 150, tracks: pick(['study-sessions-1', 'quiet-orbit-2', 'study-sessions-3', 'solar-drift-2', 'quiet-orbit-3', 'study-sessions-5', 'solar-drift-4']) },
  { id: 'night-drive', title: 'Night Drive', description: 'Synths and city lights.', hue: 270, tracks: pick(['city-of-echoes-2', 'glass-harbour-5', 'velvet-circuit-4', 'city-of-echoes-5', 'glass-harbour-3', 'velvet-circuit-1']) },
  { id: 'sunday', title: 'Slow Sunday', description: 'Acoustic and easy.', hue: 30, tracks: pick(['paper-kites-1', 'northern-wires-2', 'paper-kites-5', 'northern-wires-4', 'paper-kites-7']) },
];

export const MUSIC_ARTISTS = [...new Set(ALL.map((track) => track.artist))].map((name) => ({
  name,
  hue: MUSIC_ALBUMS.find((album) => album.artist === name)?.hue ?? 0,
}));

export const MUSIC_CATEGORIES = ['Ambient', 'Electronic', 'Folk', 'Indie', 'Lo-fi', 'Synthpop', 'Focus', 'Chill', 'Late Night', 'Workout', 'Mood', 'New'].map((name, i) => ({ name, hue: (i * 31 + 200) % 360 }));

export function searchMusic(rawQuery: string) {
  const query = rawQuery.trim().toLowerCase().slice(0, 100);
  const has = (...values: string[]) => values.some((value) => value.toLowerCase().includes(query));
  if (!query) return { songs: [], albums: [], artists: [], playlists: [] };
  return {
    songs: ALL.filter((track) => has(track.title, track.artist, track.album)),
    albums: MUSIC_ALBUMS.filter((album) => has(album.title, album.artist, album.genre)),
    artists: MUSIC_ARTISTS.filter((artist) => has(artist.name)),
    playlists: MUSIC_PLAYLISTS.filter((playlist) => has(playlist.title, playlist.description)),
  };
}
