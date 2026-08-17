import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../utils/logger.js';

export async function ensureTempDir(tempDir: string): Promise<void> {
  if (!existsSync(tempDir)) {
    await mkdir(tempDir, { recursive: true });
  }
}

/** Removes files in the temp directory older than maxAgeMs. */
export async function cleanupTempDir(
  tempDir: string,
  maxAgeMs: number,
  logger: Logger
): Promise<void> {
  if (!existsSync(tempDir)) return;

  try {
    const files = await readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(tempDir, file);
      try {
        const info = await stat(filePath);
        if (now - info.mtimeMs > maxAgeMs) {
          await rm(filePath, { force: true });
          logger.debug('Cleaned up temp file', { file });
        }
      } catch {
        // A file that vanished or cannot be stat'd is not worth failing over.
      }
    }
  } catch (error) {
    logger.warn('Failed to clean temp directory', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
