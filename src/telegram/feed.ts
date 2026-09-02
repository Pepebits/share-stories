import type { MediaFacts } from '../instagram/limits.js';

/**
 * The GramJS-facing shapes a story feed is built from, and the pure functions
 * that read them — no client, no logging, no I/O, so this is testable without
 * Telegram.
 */

/** GramJS returns ids as BigInteger instances, not numbers. */
export type PeerId = { toString(): string };

/** Telegram allows several usernames; the legacy field is null when it does. */
export interface RawPeer {
  id: PeerId;
  username?: string | null;
  usernames?: { username?: string }[];
  title?: string;
  firstName?: string;
}

export interface RawStory {
  id?: number;
  date?: number;
  caption?: string | null;
  media?: unknown;
  /** Audience flags. Telegram sets only the ones that apply. */
  public?: boolean;
  closeFriends?: boolean;
  contacts?: boolean;
  selectedContacts?: boolean;
  /** The author disabled forwarding and screenshots. */
  noforwards?: boolean;
  /**
   * 'StoryItem' when the story arrived whole. GetAllStories sends only the
   * newest few that way; everything behind them comes as a 'StoryItemSkipped'
   * placeholder holding an id and a date and nothing else, and gaps in the
   * numbering come as 'StoryItemDeleted'.
   */
  className?: string;
}

/** The shape of the two media types a story can carry, as GramJS returns them. */
export interface RawMedia {
  document?: {
    size?: { toString(): string } | number;
    mimeType?: string;
    attributes?: { className?: string; duration?: number }[];
  };
  photo?: { sizes?: { size?: number }[] };
}

export interface PeerNames {
  handles: string[];
  title?: string;
}

export function namesOf(peer: RawPeer): PeerNames {
  const handles = [
    ...(peer.username ? [peer.username] : []),
    ...(peer.usernames ?? []).flatMap((u) => (u.username ? [u.username] : [])),
  ];
  return { handles, title: peer.title ?? peer.firstName };
}

/** A human label for logging: the first handle, then the title, then the raw id. */
export function peerLabel(peerId: string, names: PeerNames | undefined): string {
  return names?.handles[0] ? `@${names.handles[0]}` : (names?.title ?? peerId);
}

/**
 * Whether a peer is one of the monitored ones, matched by id, title, or any
 * active username — private channels have nothing else to be named by.
 */
export function matchesPeer(
  monitored: string[],
  peerId: string,
  names: PeerNames | undefined
): boolean {
  const wanted = monitored.map((entry) => entry.replace(/^@/, '').toLowerCase());
  return wanted.some(
    (w) =>
      w === peerId ||
      w === names?.title?.toLowerCase() ||
      (names?.handles ?? []).some((handle) => handle.toLowerCase() === w)
  );
}

/**
 * What Telegram says about a story's media before any of it is downloaded.
 *
 * Sizes arrive as BigInteger, and a story whose media is a document could be
 * either a photo or a video — the mime type is the only hint available this
 * early, and it is only used to pick which limit applies.
 */
export function describeTelegramMedia(media: unknown): MediaFacts {
  const raw = (media ?? {}) as RawMedia;

  if (raw.document) {
    const video = (raw.document.attributes ?? []).find(
      (attribute) => attribute.className === 'DocumentAttributeVideo'
    );
    const size = raw.document.size;

    return {
      mediaType: raw.document.mimeType?.startsWith('video/') ? 'video' : 'photo',
      bytes: size === undefined ? undefined : Number(size.toString()),
      durationSeconds: video?.duration,
    };
  }

  if (raw.photo) {
    // Several renditions are offered; downloadMedia takes the largest.
    const sizes = (raw.photo.sizes ?? []).map((size) => size.size ?? 0);
    return { mediaType: 'photo', bytes: sizes.length ? Math.max(...sizes) : undefined };
  }

  return { mediaType: 'photo' };
}

/**
 * Detects video from magic bytes rather than trusting the field a story
 * arrived in — Telegram delivers both photos and videos as documents.
 */
export function isVideoBuffer(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;

  // MP4/MOV carry 'ftyp' at offset 4.
  const isMp4 =
    buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70;

  // WebM/Matroska start with the EBML magic number.
  const isWebm =
    buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;

  return isMp4 || isWebm;
}
