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
