import { expect } from 'chai';
import { Schema } from 'effect';
import {
  ReplayEvent, ReplayMetadata, TabEvent, RrwebEventBatch,
  SessionId, ReplayStoreError, TabFlushError,
} from './replay-schemas.js';

describe('Replay Schemas', () => {
  describe('ReplayEvent', () => {
    it('decodes a valid rrweb event', () => {
      const raw = { type: 2, timestamp: 1709000000000, data: { node: {} } };
      const result = Schema.decodeUnknownSync(ReplayEvent)(raw);
      expect(result.type).to.equal(2);
      expect(result.timestamp).to.equal(1709000000000);
    });

    it('rejects event with missing type', () => {
      const raw = { timestamp: 1709000000000, data: {} };
      expect(() => Schema.decodeUnknownSync(ReplayEvent)(raw)).to.throw();
    });
  });

  describe('TabEvent', () => {
    it('decodes a tab event with branded IDs', () => {
      const raw = {
        sessionId: 'sess-123',
        targetId: 'target-456',
        event: { type: 3, timestamp: 1709000000000, data: {} },
      };
      const result = Schema.decodeUnknownSync(TabEvent)(raw);
      expect(result.sessionId).to.equal('sess-123');
      expect(result.targetId).to.equal('target-456');
    });
  });

  describe('RrwebEventBatch', () => {
    it('decodes array of events', () => {
      const raw = [
        { type: 2, timestamp: 1000, data: {} },
        { type: 3, timestamp: 2000, data: { source: 1 } },
      ];
      const result = Schema.decodeUnknownSync(RrwebEventBatch)(raw);
      expect(result).to.have.length(2);
    });

    it('rejects non-array', () => {
      expect(() => Schema.decodeUnknownSync(RrwebEventBatch)('not-array')).to.throw();
    });
  });

  describe('ReplayMetadata', () => {
    it('decodes full metadata', () => {
      const raw = {
        id: 'replay-1', browserType: 'chrome', routePath: '/test',
        startedAt: 1000, endedAt: 2000, duration: 1000,
        eventCount: 50, frameCount: 10, encodingStatus: 'none',
      };
      const result = Schema.decodeUnknownSync(ReplayMetadata)(raw);
      expect(result.id).to.equal('replay-1');
      expect(result.encodingStatus).to.equal('none');
    });

    it('accepts optional fields', () => {
      const raw = {
        id: 'replay-2', browserType: 'chrome', routePath: '/test',
        startedAt: 1000, endedAt: 2000, duration: 1000,
        eventCount: 0, frameCount: 0, encodingStatus: 'completed',
        trackingId: 'track-1', userAgent: 'Mozilla/5.0',
        parentSessionId: 'parent-1', targetId: 'tgt-1',
      };
      const result = Schema.decodeUnknownSync(ReplayMetadata)(raw);
      expect(result.trackingId).to.equal('track-1');
    });

    it('rejects invalid encodingStatus', () => {
      const raw = {
        id: 'x', browserType: 'x', routePath: 'x',
        startedAt: 0, endedAt: 0, duration: 0,
        eventCount: 0, frameCount: 0, encodingStatus: 'invalid',
      };
      expect(() => Schema.decodeUnknownSync(ReplayMetadata)(raw)).to.throw();
    });

    it('accepts all valid encoding statuses', () => {
      for (const status of ['none', 'deferred', 'pending', 'encoding', 'completed', 'failed']) {
        const raw = {
          id: 'x', browserType: 'x', routePath: 'x',
          startedAt: 0, endedAt: 0, duration: 0,
          eventCount: 0, frameCount: 0, encodingStatus: status,
        };
        const result = Schema.decodeUnknownSync(ReplayMetadata)(raw);
        expect(result.encodingStatus).to.equal(status);
      }
    });
  });

  describe('Tagged Errors', () => {
    it('creates ReplayStoreError with tag', () => {
      const err = new ReplayStoreError({ message: 'db failed' });
      expect(err._tag).to.equal('ReplayStoreError');
      expect(err.message).to.equal('db failed');
    });

    it('creates TabFlushError with tag and targetId', () => {
      const err = new TabFlushError({ targetId: 'tgt-1' as any, reason: 'write failed' });
      expect(err._tag).to.equal('TabFlushError');
    });
  });

  describe('SessionId brand', () => {
    it('accepts a valid string', () => {
      const result = Schema.decodeUnknownSync(SessionId)('sess-abc');
      expect(result).to.equal('sess-abc');
    });
  });
});
