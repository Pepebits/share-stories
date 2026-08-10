import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Logger } from '../utils/logger.js';

/**
 * Ensure the temp directory exists.
 */
export async function ensureTempDir(tempDir: string): Promise<void> {
  if (!existsSync(tempDir)) {
    await mkdir(tempDir, { recursive: true });
  }
}

/**
 * Clean up all files in the temp directory older than maxAgeMs.
 */
export async function cleanupTempDir(
  tempDir: string,
  maxAgeMs: number = 3600000, // 1 hour
  logger: Logger
): Promise<void> {
  if (!existsSync(tempDir)) return;

  try {
    const { readdir, stat } = await import('fs/promises');
    const files = await readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(tempDir, file);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > maxAgeMs) {
          await rm(filePath, { force: true });
          logger.debug('Cleaned up temp file', { file });
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch (error) {
    logger.warn('Failed to clean temp directory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Detect if a buffer is a video based on magic bytes.
 */
export function isVideoBuffer(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;

  // MP4/MOV: bytes 4-7 = "ftyp"
  const isMp4 =
    buffer[4] === 0x66 && // 'f'
    buffer[5] === 0x74 && // 't'
    buffer[6] === 0x79 && // 'y'
    buffer[7] === 0x70;   // 'p'

  // WebM/Matroska: bytes 0-3 = 0x1A 0x45 0xDF 0xA3
  const isWebm =
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3;

  return isMp4 || isWebm;
}

/**
 * Generate a unique filename for a story media item.
 */
export function generateMediaFilename(
  sourcePlatform: string,
  storyId: string,
  isVideo: boolean
): string {
  const hash = createHash('md5')
    .update(`${sourcePlatform}-${storyId}`)
    .digest('hex')
    .substring(0, 8);
  const ext = isVideo ? 'mp4' : 'jpg';
  return `${hash}.${ext}`;
}

/**
 * Truncate a caption to a maximum length, appending ellipsis if needed.
 */
export function truncateCaption(caption: string, maxLength: number = 1000): string {
  if (caption.length <= maxLength) return caption;
  return caption.substring(0, maxLength - 3) + '...';
}
