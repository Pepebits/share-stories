import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  namesOf,
  peerLabel,
  matchesPeer,
  describeTelegramMedia,
  isVideoBuffer,
  type RawPeer,
} from '../src/telegram/feed.js';

/**
 * Pure Telegram shape-reading, kept apart from GramJS so it is testable
 * without a client, a session, or the network.
 */
describe('namesOf', () => {
  it('reads the legacy username field', () => {
    const peer: RawPeer = { id: { toString: () => '1' }, username: 'legacy_handle' };
    assert.deepEqual(namesOf(peer).handles, ['legacy_handle']);
  });

  it('reads the usernames array when the legacy field is null', () => {
    const peer: RawPeer = {
      id: { toString: () => '1' },
      username: null,
      usernames: [{ username: 'second_handle' }],
    };
    assert.deepEqual(namesOf(peer).handles, ['second_handle']);
  });

  it('carries the title', () => {
    const peer: RawPeer = { id: { toString: () => '1' }, title: 'Some Channel' };
    assert.equal(namesOf(peer).title, 'Some Channel');
  });

  it('falls back to firstName when there is no title', () => {
    const peer: RawPeer = { id: { toString: () => '1' }, firstName: 'Ada' };
    assert.equal(namesOf(peer).title, 'Ada');
  });
});

describe('matchesPeer', () => {
  it('matches by @handle', () => {
    assert.equal(matchesPeer(['@somechannel'], '1', { handles: ['somechannel'] }), true);
  });

  it('matches a handle configured without the leading @', () => {
    assert.equal(matchesPeer(['somechannel'], '1', { handles: ['somechannel'] }), true);
  });

  it('matches case-insensitively', () => {
    assert.equal(matchesPeer(['@SomeChannel'], '1', { handles: ['somechannel'] }), true);
  });

  it('matches by the second username in the array', () => {
    assert.equal(matchesPeer(['@second'], '1', { handles: ['first', 'second'] }), true);
  });

  it('matches by title', () => {
    assert.equal(matchesPeer(['some channel'], '1', { handles: [], title: 'Some Channel' }), true);
  });

  it('matches by numeric id', () => {
    assert.equal(matchesPeer(['12345'], '12345', undefined), true);
  });

  it('does not match when nothing lines up', () => {
    assert.equal(matchesPeer(['@other'], '1', { handles: ['somechannel'] }), false);
  });

  it('matches an undefined names only by id', () => {
    assert.equal(matchesPeer(['1'], '1', undefined), true);
    assert.equal(matchesPeer(['@somechannel'], '1', undefined), false);
  });
});

describe('peerLabel', () => {
  it('prefers the first handle', () => {
    const names = { handles: ['somechannel'], title: 'Some Channel' };
    assert.equal(peerLabel('1', names), '@somechannel');
  });

  it('falls back to the title when there is no handle', () => {
    assert.equal(peerLabel('1', { handles: [], title: 'Some Channel' }), 'Some Channel');
  });

  it('falls back to the peer id when there is nothing else', () => {
    assert.equal(peerLabel('1', undefined), '1');
    assert.equal(peerLabel('1', { handles: [] }), '1');
  });
});

describe('describeTelegramMedia', () => {
  it('reads a video document', () => {
    const media = {
      document: {
        size: { toString: () => '12345' },
        mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeVideo', duration: 18.5 }],
      },
    };
    assert.deepEqual(describeTelegramMedia(media), {
      mediaType: 'video',
      bytes: 12345,
      durationSeconds: 18.5,
    });
  });

  it('reads an image document', () => {
    const media = { document: { size: 4096, mimeType: 'image/jpeg' } };
    assert.deepEqual(describeTelegramMedia(media), {
      mediaType: 'photo',
      bytes: 4096,
      durationSeconds: undefined,
    });
  });

  it('takes the largest photo rendition', () => {
    const media = { photo: { sizes: [{ size: 100 }, { size: 900 }, { size: 500 }] } };
    assert.equal(describeTelegramMedia(media).bytes, 900);
  });

  it('reports a photo with no bytes when media is absent', () => {
    assert.deepEqual(describeTelegramMedia(undefined), { mediaType: 'photo' });
  });
});

describe('isVideoBuffer', () => {
  it('recognises an mp4/mov by its ftyp marker', () => {
    const buffer = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0]);
    assert.equal(isVideoBuffer(buffer), true);
  });

  it('recognises a webm by its EBML magic number', () => {
    const buffer = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    assert.equal(isVideoBuffer(buffer), true);
  });

  it('rejects a buffer too short to hold either marker', () => {
    assert.equal(isVideoBuffer(Buffer.from([0, 1, 2])), false);
  });

  it('rejects a jpeg', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    assert.equal(isVideoBuffer(buffer), false);
  });
});
