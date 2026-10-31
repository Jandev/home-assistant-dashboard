export function musicSource(item) {
  // library:// means an MA database entry, not necessarily a local file.
  const hints = [item.provider, item.uri, ...(item.provider_mappings || []).flatMap(p => [p.provider_domain, p.provider_instance])].filter(Boolean).join(' ');
  let imageProvider = '';
  try { imageProvider = new URL(item.image).searchParams.get('provider') || ''; } catch {}
  if (/apple_music/i.test(hints) || /apple_music/i.test(imageProvider)) return 'Apple Music';
  if (/filesystem|local_file/i.test(hints + ' ' + imageProvider)) return 'Lokale bibliotheek';
  // Artwork may have been copied between providers; its CDN is not proof of origin.
  if (String(item.uri).startsWith('library://')) return 'Music Assistant-bibliotheek';
  return String(item.provider || item.uri?.split('://')[0] || 'Onbekende bron');
}
