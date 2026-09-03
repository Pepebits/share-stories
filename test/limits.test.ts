import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectionReason,
  MAX_VIDEO_SECONDS,
  MAX_VIDEO_BYTES,
  MAX_PHOTO_BYTES,
} from '../src/instagram/limits.js';

/**
 * Meta accepts a container for media it will later refuse, then ends it in
 * ERROR minutes afterwards with nothing attached. Everything here exists so
 * that failure is a sentence in the log instead.
 */
describe('rejectionReason', () => {
  describe('what Instagram accepts', () => {
    it('passes a normal story video', () => {
      assert.equal(
        rejectionReason({ mediaType: 'video', bytes: 12_803_127, durationSeconds: 18.03 }),
        null
      );
    });

    it('passes a normal story photo', () => {
      assert.equal(rejectionReason({ mediaType: 'photo', bytes: 131_252 }), null);
    });

    it('passes a video exactly at the duration limit', () => {
      assert.equal(
        rejectionReason({ mediaType: 'video', durationSeconds: MAX_VIDEO_SECONDS }),
        null
      );
    });

    it('passes media exactly at the size limit', () => {
      assert.equal(rejectionReason({ mediaType: 'video', bytes: MAX_VIDEO_BYTES }), null);
      assert.equal(rejectionReason({ mediaType: 'photo', bytes: MAX_PHOTO_BYTES }), null);
    });
  });

  describe('what it refuses', () => {
    it('refuses empty media, whatever it claims to be', () => {
      assert.match(rejectionReason({ mediaType: 'video', bytes: 0 }) ?? '', /empty/);
      assert.match(rejectionReason({ mediaType: 'photo', bytes: 0 }) ?? '', /empty/);
    });

    it('refuses a video past sixty seconds', () => {
      const reason = rejectionReason({ mediaType: 'video', durationSeconds: 61.5 });
      assert.match(reason ?? '', /61\.5s/);
      assert.match(reason ?? '', /60s limit/);
    });

    it('refuses an oversized video', () => {
      assert.match(
        rejectionReason({ mediaType: 'video', bytes: MAX_VIDEO_BYTES + 1 }) ?? '',
        /over Instagram's/
      );
    });

    it('refuses an oversized photo', () => {
      assert.match(
        rejectionReason({ mediaType: 'photo', bytes: MAX_PHOTO_BYTES + 1 }) ?? '',
        /over Instagram's/
      );
    });

    // A photo is allowed 8MB and a video 100MB, so reading the type off the
    // wrong field would wave through something twelve times too big.
    it('holds a photo to the photo limit, not the video one', () => {
      const tooBig = MAX_PHOTO_BYTES + 1;
      assert.notEqual(rejectionReason({ mediaType: 'photo', bytes: tooBig }), null);
      assert.equal(rejectionReason({ mediaType: 'video', bytes: tooBig }), null);
    });
  });

  /**
   * The reader knows size and duration before downloading; the publisher knows
   * the bytes it holds. Neither should be blocked by what it cannot see.
   */
  describe('partial knowledge', () => {
    it('does not refuse a story it knows nothing about', () => {
      assert.equal(rejectionReason({ mediaType: 'video' }), null);
      assert.equal(rejectionReason({ mediaType: 'photo' }), null);
    });

    it('checks duration even when the size is unknown', () => {
      assert.notEqual(rejectionReason({ mediaType: 'video', durationSeconds: 90 }), null);
    });

    it('checks size even when the duration is unknown', () => {
      assert.notEqual(rejectionReason({ mediaType: 'video', bytes: MAX_VIDEO_BYTES + 1 }), null);
    });

    it('ignores duration on a photo, which has none', () => {
      assert.equal(rejectionReason({ mediaType: 'photo', durationSeconds: 900 }), null);
    });
  });
});
