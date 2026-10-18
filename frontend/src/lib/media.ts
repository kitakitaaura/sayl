/** Files the browser may play while they download, by extension, with the type to serve them as. */
export const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

export const extensionOf = (path: string) => path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
export const mediaType = (path: string): string | null => MEDIA_TYPES[extensionOf(path)] ?? null;
export const isAudio = (path: string) => mediaType(path)?.startsWith('audio/') ?? false;
